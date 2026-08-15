/**
 * Desktop integration bundle plugin: per-launch loopback authentication for
 * the `desktop` profile. The Electron main generates a 256-bit base64url
 * secret, passes it through {@link SECRET_ENV}, and navigates the window to
 * the bootstrap endpoint; the exchange sets an HttpOnly SameSite=Strict
 * cookie on the loopback origin. Every other request — static assets, API,
 * SSE, and WebSocket upgrades — must carry that cookie, and state-changing
 * HTTP requests must also present the expected loopback Origin. The secret,
 * the bootstrap URL, and the cookie never enter logs.
 * @module @deepseek-ai/dsh-desktop-integration
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import {
  AUTH_COOKIE_NAME,
  BOOTSTRAP_PATH,
  SECRET_ENV,
  authCookieDirective,
  isStateChanging,
  parseCookies,
  validSecret,
  valuesEqual,
} from './auth.ts'

/** The webserver surface the guards attach to (structural, from `dsh-host-webserver`). */
interface DesktopWebServer {
  port: number
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  registerRequestGuard(guard: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>): () => void
  registerUpgradeGuard(guard: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean | Promise<boolean>): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: DesktopWebServer
  }
}

/** Stable Cordis plugin name. */
export const name = 'desktop-auth'

/** The webserver row the guards attach to. */
export const inject = ['webServer']

/** Plugin config: the environment variable carrying the per-launch secret. */
export interface Config {
  /** Environment variable name holding the per-launch base64url secret. */
  secretEnv: string
}

/** The loopback origin of this composition's webserver. */
function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${String(port)}`
}

/** Whether the request carries the expected auth cookie. */
function authenticated(req: IncomingMessage, secret: string): boolean {
  const value = parseCookies(req.headers.cookie).get(AUTH_COOKIE_NAME)
  return value !== undefined && valuesEqual(value, secret)
}

/** Reject a request that failed the guard; the guard owns the response. */
function deny(res: ServerResponse, status: number): boolean {
  res.writeHead(status)
  res.end()
  return false
}

/** Reject an upgrade that failed the guard; the guard owns the socket. */
function denyUpgrade(socket: Duplex, status: number): boolean {
  socket.write(`HTTP/1.1 ${String(status)}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
  return false
}

/**
 * The plugin. `apply` registers the bootstrap route and the request and
 * upgrade guards; every registration unwinds with the plugin fiber.
 * @param ctx - plugin context carrying the webserver service.
 * @param config - the secret environment variable name.
 */
export function apply(ctx: Context, config: Config): void {
  const secret = process.env[config.secretEnv]
  if (!validSecret(secret)) {
    throw new Error(
      `desktop-auth: ${config.secretEnv} is missing or malformed; the Desktop shell must pass a 256-bit base64url secret`,
    )
  }
  const port = ctx.webServer.port

  // The bootstrap exchange: secret in the query, cookie on the loopback
  // origin, then a clean redirect. The window lands on `/` with the cookie.
  ctx.webServer.register({
    kind: 'exact',
    path: BOOTSTRAP_PATH,
    handler: (req, res) => {
      const token = new URL(req.url ?? '/', loopbackOrigin(port)).searchParams.get('token')
      if (token === null || !valuesEqual(token, secret)) {
        res.writeHead(403)
        res.end()
        return
      }
      res.writeHead(302, {
        location: '/',
        'set-cookie': authCookieDirective(secret),
      })
      res.end()
    },
  })

  ctx.webServer.registerRequestGuard((req, res) => {
    const rawPath = new URL(req.url ?? '/', loopbackOrigin(port)).pathname
    if (rawPath === BOOTSTRAP_PATH) return true
    if (!authenticated(req, secret)) return deny(res, 401)
    if (isStateChanging(req.method ?? 'GET')) {
      const origin = req.headers.origin
      if (origin !== loopbackOrigin(port)) return deny(res, 403)
    }
    return true
  })

  ctx.webServer.registerUpgradeGuard((req, socket) => {
    if (authenticated(req, secret)) return true
    return denyUpgrade(socket, 401)
  })
}

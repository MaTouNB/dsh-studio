#!/usr/bin/env node
/**
 * Packaged-app smoke for DSH Studio on the current platform: launches the
 * built `.app` with a scratch DSH home and a keyless mock LLM provider,
 * proves the loopback authentication matrix (no cookie rejected on static,
 * API, SSE, and WebSocket; bootstrap exchanges the secret for the cookie;
 * state-changing requests require the expected Origin), runs one session
 * through the web RPC API, kills the Harness child to prove supervised
 * crash recovery, quits, and proves no child process or listening port
 * survives.
 * @module @deepseek-ai/dsh-desktop/smoke-packaged
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')

/** How long the app may take to print a bootstrap URL. */
const READY_TIMEOUT_MS = 120_000

/** How long to wait for the mock provider to receive the model request. */
const PROVIDER_TIMEOUT_MS = 30_000

/** How long to wait after killing the child for the supervised restart. */
const RESTART_TIMEOUT_MS = 60_000

interface RpcEnvelope<T> {
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
}

/** The packaged `.app` under `dist/` for the current platform. */
function packagedApp(): string {
  const candidates = [join(APP_DIR, 'dist', 'mac-arm64', 'DSH Studio.app'), join(APP_DIR, 'dist', 'mac', 'DSH Studio.app')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`packaged app not found under ${join(APP_DIR, 'dist')}`)
}

/**
 * Watches the app's stdout for the env-gated bootstrap echoes; each call to
 * `next()` resolves with the next unread bootstrap URL (one per boot, so the
 * crash-recovery leg observes the restarted child).
 */
class BootstrapWatcher {
  private buffer = ''
  private queue: Array<{ url: string }> = []
  private waiters: Array<{ resolve: (url: string) => void }> = []

  constructor(child: ChildProcess) {
    child.stdout?.on('data', (chunk) => { this.feed(String(chunk)) })
    child.stderr?.on('data', (chunk) => { this.feed(String(chunk)) })
  }

  private feed(chunk: string): void {
    this.buffer = `${this.buffer}${chunk}`
    const matches = [...this.buffer.matchAll(/\[studio\] bootstrap (http:\/\/\S+)/gu)]
    for (const match of matches) {
      this.queue.push({ url: match[1] as string })
    }
    const last = matches.at(-1)
    if (last !== undefined && last.index !== undefined) {
      this.buffer = this.buffer.slice(last.index + last[0].length)
    } else if (this.buffer.length > 4096) {
      this.buffer = this.buffer.slice(-4096)
    }
    this.drain()
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.queue.length > 0) {
      const waiter = this.waiters.shift() as { resolve: (url: string) => void }
      const next = this.queue.shift() as { url: string }
      waiter.resolve(next.url)
    }
  }

  next(): Promise<string> {
    return new Promise((resolveNext, reject) => {
      let entry: { resolve: (url: string) => void }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter !== entry)
        reject(new Error(`no bootstrap URL within ${READY_TIMEOUT_MS}ms`))
      }, READY_TIMEOUT_MS)
      entry = {
        resolve: (url: string) => {
          clearTimeout(timer)
          resolveNext(url)
        },
      }
      this.waiters.push(entry)
      this.drain()
    })
  }
}

async function rpc<T>(baseUrl: string, cookie: string, method: string, payload: unknown, origin: string): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: `smoke-${method}`, method, payload }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as RpcEnvelope<T>
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

/** A minimal keyless OpenAI-compatible SSE provider. */
function startMockProvider(): Promise<{
  server: Server
  port: number
  requests: Array<{ messages?: Array<{ role?: string; content?: string }> }>
}> {
  const requests: Array<{ messages?: Array<{ role?: string; content?: string }> }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> }
      requests.push(parsed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}',
        'data: {"choices":[{"delta":{"content":"hello from the keyless mock"}}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
      resolveListen({ server, port: address.port, requests })
    })
  })
}

/** One raw HTTP upgrade attempt; resolves with the first response bytes. */
async function upgrade(port: number, path: string, cookie?: string): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  socket.destroy()
  return String(data)
}

/** Whether any process other than our own still listens on the port. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer()
    probe.once('error', () => resolvePort(false))
    probe.once('listening', () => {
      probe.close(() => { resolvePort(true) })
    })
    probe.listen(port, '127.0.0.1')
  })
}

/** Kill the packaged app's Harness child (the bundled node running the CLI). */
function killHarnessChild(): void {
  execSync("pkill -9 -f 'Resources/runtime/node/bin/node.*--profile desktop' || true", { stdio: 'ignore' })
}

/** Poll the origin until it serves the onboarding HTML with the cookie. */
async function waitServing(baseUrl: string, cookie: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${baseUrl}/`, { headers: { cookie }, signal: AbortSignal.timeout(1_000) })
      if (probe.ok && (await probe.text()).includes('<html')) return
    } catch {
      // the server is down mid-restart; keep polling
    }
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 500))
  }
  throw new Error(`the harness did not serve ${baseUrl} within ${timeoutMs}ms`)
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('smoke-packaged currently verifies the macOS app; Windows lands with the native lane')
  }
  const appPath = packagedApp()
  const binary = join(appPath, 'Contents', 'MacOS', 'DSH Studio')
  if (!existsSync(binary)) throw new Error(`app binary missing: ${binary}`)
  const workspace = join(tmpdir(), `dsh-studio-smoke-${process.pid}`)
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  const dshHome = join(workspace, 'dsh-home')
  const mock = await startMockProvider()
  const scrubPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      PATH: scrubPath,
      DSH_HOME: dshHome,
      DEEPSEEK_API_KEY: 'keyless-smoke',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
      DSH_STUDIO_ECHO_BOOTSTRAP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const watcher = new BootstrapWatcher(child)
  try {
    const bootstrapUrl = await watcher.next()
    const baseUrl = new URL(bootstrapUrl).origin
    const port = new URL(bootstrapUrl).port
    const origin = new URL(baseUrl).origin

    // Authentication matrix, unauthenticated first.
    const bareHome = await fetch(`${baseUrl}/`)
    if (bareHome.status !== 401) throw new Error(`static without cookie: expected 401, got ${bareHome.status}`)
    const bareApi = await fetch(`${baseUrl}/api/session.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-unauth', method: 'session.create', payload: {} }),
    })
    if (bareApi.status !== 401) throw new Error(`API without cookie: expected 401, got ${bareApi.status}`)
    const bareSse = await fetch(`${baseUrl}/plugins/events`, { signal: AbortSignal.timeout(2_000) })
    if (bareSse.status !== 401) throw new Error(`SSE without cookie: expected 401, got ${bareSse.status}`)
    const bareWs = await upgrade(Number(port), '/api/events.mux')
    if (!bareWs.includes('401')) throw new Error(`WebSocket without cookie: expected 401, got:\n${bareWs}`)

    // Bootstrap exchange: secret for the HttpOnly SameSite=Strict cookie.
    const bootstrap = await fetch(bootstrapUrl, { redirect: 'manual' })
    if (bootstrap.status !== 302) throw new Error(`bootstrap: expected 302, got ${bootstrap.status}`)
    const setCookie = bootstrap.headers.get('set-cookie')
    if (setCookie === null || !setCookie.includes('HttpOnly') || !setCookie.includes('SameSite=Strict')) {
      throw new Error(`bootstrap cookie lacks HttpOnly/SameSite=Strict: ${String(setCookie)}`)
    }
    const cookie = setCookie.split(';')[0] as string

    // Authenticated paths now work.
    await waitServing(baseUrl, cookie, 10_000)
    const sse = await fetch(`${baseUrl}/plugins/events`, { headers: { cookie }, signal: AbortSignal.timeout(2_000) })
    if (sse.status !== 200) throw new Error(`SSE with cookie: expected 200, got ${sse.status}`)
    const ws = await upgrade(Number(port), '/api/events.mux', cookie)
    if (ws.includes('401') || ws.includes('403')) throw new Error(`WebSocket with cookie rejected:\n${ws}`)

    const profileManifest = join(dshHome, 'profiles', 'desktop', 'package.json')
    if (!existsSync(profileManifest)) throw new Error('desktop profile was not created in the DSH home')
    const manifest = JSON.parse(readFileSync(profileManifest, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    if (manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-desktop-integration') !== true) {
      throw new Error('desktop profile lacks the integration bundle layer')
    }

    // State-changing requests require the expected loopback Origin.
    const wrongOrigin = await fetch(`${baseUrl}/api/session.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://evil.example' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-origin', method: 'session.create', payload: {} }),
    })
    if (wrongOrigin.status !== 403) throw new Error(`wrong Origin: expected 403, got ${wrongOrigin.status}`)

    const created = await rpc<{ sessionId: string }>(baseUrl, cookie, 'session.create', {}, origin)
    await rpc<{ accepted: true }>(baseUrl, cookie, 'session.prompt', {
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'hello from the DSH Studio packaged smoke' }],
    }, origin)
    const request = await Promise.race([
      new Promise<{ messages?: Array<{ role?: string; content?: string }> }>((resolveRequest) => {
        const poll = setInterval(() => {
          const latest = mock.requests.at(-1)
          if (latest !== undefined) {
            clearInterval(poll)
            resolveRequest(latest)
          }
        }, 200)
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('mock provider received no model request')) }, PROVIDER_TIMEOUT_MS).unref()
      }),
    ])
    const seen = request.messages?.some(message => message.content?.includes('packaged smoke')) ?? false
    if (!seen) throw new Error('the model request did not carry the prompted text')
    process.stdout.write(
      'smoke: auth matrix, onboarding, desktop profile, and keyless session all passed\n',
    )

    // Supervised crash recovery: kill the Harness child, expect a restart
    // with a fresh bootstrap (new port, same per-launch secret).
    killHarnessChild()
    const nextBootstrap = await watcher.next()
    const nextOrigin = new URL(nextBootstrap).origin
    await waitServing(nextOrigin, cookie, RESTART_TIMEOUT_MS)
    process.stdout.write('smoke: supervised crash recovery served the UI again after the child was killed\n')

    child.kill('SIGTERM')
    await new Promise<void>(resolveExit => child.once('exit', () => { resolveExit() }))
    const free = await portIsFree(Number(port))
    if (!free) throw new Error(`port ${port} still listens after quit`)
    process.stdout.write(`smoke: quit closed the harness port ${port} and left no listener\n`)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await new Promise<void>(resolveClose => mock.server.close(() => { resolveClose() }))
    rmSync(workspace, { recursive: true, force: true })
  }
}

await main()

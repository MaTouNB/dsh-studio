/**
 * Loopback authentication primitives for the Desktop integration bundle:
 * per-launch secret validation, cookie parsing, state-changing detection,
 * and constant-time cookie comparison. Pure and dependency-free so tests
 * pin the policy without a running composition.
 * @module @deepseek-ai/dsh-desktop-integration/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** The HttpOnly cookie set by the bootstrap exchange. */
export const AUTH_COOKIE_NAME = 'dsh_desktop_auth'

/** The bootstrap endpoint path that exchanges the secret for the cookie. */
export const BOOTSTRAP_PATH = '/desktop-bootstrap'

/** The environment variable the Electron main passes the per-launch secret through. */
export const SECRET_ENV = 'DSH_DESKTOP_SECRET'

/** Minimum base64url length for the per-launch secret (256 bits → 43 chars). */
export const MIN_SECRET_LENGTH = 32

/** Methods whose requests must also carry the expected loopback Origin. */
export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Whether a per-launch secret is well formed: base64url, long enough to be
 * 256 bits. A malformed secret must fail the boot loud rather than run an
 * authentication nobody can pass.
 * @param secret - the raw environment value.
 * @returns `true` when the secret is usable.
 */
export function validSecret(secret: string | undefined): secret is string {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) return false
  return /^[A-Za-z0-9_-]+$/u.test(secret)
}

/** The fixed-length digest used for constant-time comparisons. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Constant-time equality of two values by their digests. Hash comparison
 * keeps `timingSafeEqual` on fixed-length buffers and never exposes the
 * secret itself.
 * @param left - one value.
 * @param right - the other value.
 * @returns whether the digests match.
 */
export function valuesEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right))
}

/**
 * Parse a Cookie header into name → value pairs. The first `=` splits each
 * pair; malformed pairs are skipped.
 * @param header - the raw `Cookie` header, or `undefined` when absent.
 * @returns the parsed pairs.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (header === undefined) return cookies
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    cookies.set(trimmed.slice(0, at), trimmed.slice(at + 1))
  }
  return cookies
}

/**
 * Whether the request method changes state and therefore must carry the
 * expected loopback Origin.
 * @param method - the HTTP method.
 * @returns `true` for state-changing methods.
 */
export function isStateChanging(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase())
}

/**
 * The Set-Cookie directive for the auth cookie on the loopback origin.
 * HttpOnly keeps the renderer's scripts from reading it; SameSite=Strict
 * keeps every other site's requests from carrying it.
 * @param secret - the per-launch secret the cookie holds.
 * @returns the full `Set-Cookie` header value.
 */
export function authCookieDirective(secret: string): string {
  return `${AUTH_COOKIE_NAME}=${secret}; HttpOnly; SameSite=Strict; Path=/`
}

import { describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME,
  BOOTSTRAP_PATH,
  SECRET_ENV,
  STATE_CHANGING_METHODS,
  authCookieDirective,
  isStateChanging,
  parseCookies,
  validSecret,
  valuesEqual,
} from '../bundle/src/auth.ts'

describe('desktop auth primitives', () => {
  it('accepts a 256-bit base64url secret and rejects short or malformed ones', () => {
    const secret = 'a'.repeat(43)
    expect(validSecret(secret)).toBe(true)
    expect(validSecret('a'.repeat(31))).toBe(false)
    expect(validSecret('not base64url!'.repeat(4))).toBe(false)
    expect(validSecret(undefined)).toBe(false)
    expect(validSecret('')).toBe(false)
  })

  it('compares values in constant time by digest', () => {
    expect(valuesEqual('abc', 'abc')).toBe(true)
    expect(valuesEqual('abc', 'abd')).toBe(false)
    expect(valuesEqual('', '')).toBe(true)
  })

  it('parses Cookie headers, skipping malformed pairs', () => {
    expect(parseCookies(undefined)).toEqual(new Map())
    expect(parseCookies(`${AUTH_COOKIE_NAME}=v1; other=two`)).toEqual(new Map([
      [AUTH_COOKIE_NAME, 'v1'],
      ['other', 'two'],
    ]))
    expect(parseCookies('=novalue; valid=yes')).toEqual(new Map([['valid', 'yes']]))
  })

  it('flags exactly the state-changing methods', () => {
    expect([...STATE_CHANGING_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT'])
    expect(isStateChanging('POST')).toBe(true)
    expect(isStateChanging('get')).toBe(false)
    expect(isStateChanging('HEAD')).toBe(false)
  })

  it('builds the HttpOnly SameSite=Strict cookie directive', () => {
    const directive = authCookieDirective('secret-value')
    expect(directive).toContain(`${AUTH_COOKIE_NAME}=secret-value`)
    expect(directive).toContain('HttpOnly')
    expect(directive).toContain('SameSite=Strict')
    expect(directive).toContain('Path=/')
  })

  it('names the bootstrap path and the secret environment', () => {
    expect(BOOTSTRAP_PATH).toBe('/desktop-bootstrap')
    expect(SECRET_ENV).toBe('DSH_DESKTOP_SECRET')
  })
})

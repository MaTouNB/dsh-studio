import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RotatingLog, redact } from '../src/logging.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-log-'))
}

function fields(message: string, stream: 'stdout' | 'stderr' | 'state' | 'app' = 'app'): {
  time: string
  stream: 'stdout' | 'stderr' | 'state' | 'app'
  appVersion: string
  harnessVersion: string
  state: 'ready'
  message: string
} {
  return { time: '2026-08-15T00:00:00.000Z', stream, appVersion: '0.1.0-alpha.1', harnessVersion: '0.1.0-rc.5', state: 'ready', message }
}

describe('redact', () => {
  it('replaces every known secret value', () => {
    expect(redact('token=abc123 and abc123 again', ['abc123'])).toBe('token=[redacted] and [redacted] again')
  })

  it('skips empty secrets', () => {
    expect(redact('plain text', ['', 'needle'])).toBe('plain text')
  })
})

describe('RotatingLog', () => {
  it('appends redacted JSON lines', () => {
    const dir = tempDir()
    const log = new RotatingLog(dir, ['supersecret'])
    log.append(fields('bootstrap supersecret here'))
    const text = readFileSync(join(dir, 'dsh-studio.log'), 'utf8')
    expect(text).toContain('[redacted]')
    expect(text).not.toContain('supersecret')
    expect(text).toContain('"stream":"app"')
    expect(text).toContain('"harness":"0.1.0-rc.5"')
    expect(text).toContain('"state":"ready"')
  })

  it('rotates at the size cap and keeps the retained count', () => {
    const dir = tempDir()
    const log = new RotatingLog(dir, [], 3, 2000)
    for (let index = 0; index < 30; index += 1) {
      log.append(fields(`line ${String(index)} ${'x'.repeat(20)}`))
    }
    expect(readFileSync(log.path, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(0)
    const files = log.files()
    expect(files.length).toBeLessThanOrEqual(3)
    // Every retained file parses as JSON lines.
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        expect(() => { JSON.parse(line) }).not.toThrow()
      }
    }
    // With three retained files the whole sequence survives rotation.
    const all = log.readAll()
    expect(all).toContain('line 0')
    expect(all).toContain(`line ${String(29)}`)
  })

  it('readAll returns retained content oldest first', () => {
    const dir = tempDir()
    const log = new RotatingLog(dir, [], 3, 60)
    log.append(fields('first'))
    log.append(fields('second'))
    log.append(fields('third'))
    log.append(fields('fourth'))
    const all = log.readAll()
    expect(all.indexOf('first')).toBeLessThan(all.indexOf('second'))
    expect(all.indexOf('second')).toBeLessThan(all.indexOf('fourth'))
  })
})

describe('log redaction with credentials', () => {
  it('redacts credential-shaped environment values', () => {
    const dir = tempDir()
    const log = new RotatingLog(dir, ['secret1', 'api-key-123'])
    log.append(fields('DEEPSEEK key api-key-123 and secret1'))
    const text = readFileSync(join(dir, 'dsh-studio.log'), 'utf8')
    expect(text).not.toContain('api-key-123')
    expect(text).not.toContain('secret1')
    expect(text).toContain('[redacted]')
    writeFileSync(join(dir, 'unused'), '')
  })
})

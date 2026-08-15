/**
 * Rotating, redacted runtime logging for the Electron shell: JSON lines under
 * the platform log directory, 5 MiB per file with three retained files, and
 * every line scrubbed of the bootstrap secret and known credential values.
 * @module @deepseek-ai/dsh-desktop/logging
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeState } from './supervisor.ts'

/** One log line's fields. */
export interface LogFields {
  /** The source of the message. */
  stream: 'stdout' | 'stderr' | 'state' | 'app'
  /** The lifecycle state at the time of the line. */
  state: RuntimeState
  /** The raw message (redacted on write). */
  message: string
}

/** Redact a message: every known secret value becomes a fixed placeholder. */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message
  for (const secret of secrets) {
    if (secret === '') continue
    out = out.split(secret).join('[redacted]')
  }
  return out
}

/**
 * The rotating log. `append` writes one JSON line, rotating before the write
 * when the current file would exceed {@link MAX_BYTES}; rotation keeps
 * `base`, `base.1`, … `base.<retained-1>`. `readAll` returns the retained
 * files oldest-first for diagnostics.
 */
export class RotatingLog {
  /** The per-file cap: 5 MiB per the product requirements. */
  static readonly MAX_BYTES = 5 * 1024 * 1024

  private static readonly NAME = 'dsh-studio.log'

  constructor(
    private readonly dir: string,
    private readonly secrets: readonly string[],
    private readonly retained = 3,
    private readonly maxBytes = RotatingLog.MAX_BYTES,
  ) {
    mkdirSync(dir, { recursive: true })
  }

  /** The active log file path. */
  get path(): string {
    return join(this.dir, RotatingLog.NAME)
  }

  /** Rotate: base → .1 → .2 …, dropping the oldest. */
  private rotate(): void {
    for (let index = this.retained - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.path : `${this.path}.${String(index - 1)}`
      const to = `${this.path}.${String(index)}`
      if (existsSync(from)) renameSync(from, to)
    }
    rmSync(this.path, { force: true })
  }

  /** Append one redacted JSON line, rotating first when needed. */
  append(fields: LogFields & { time: string; appVersion: string; harnessVersion: string }): void {
    const line = `${JSON.stringify({
      time: fields.time,
      stream: fields.stream,
      app: fields.appVersion,
      harness: fields.harnessVersion,
      state: fields.state,
      message: redact(fields.message, this.secrets),
    })}\n`
    const size = existsSync(this.path) ? statSync(this.path).size : 0
    if (size + line.length > this.maxBytes) this.rotate()
    writeFileSync(this.path, line, { flag: 'a' })
  }

  /** All retained lines, oldest first. */
  readAll(): string {
    const parts: string[] = []
    for (let index = this.retained - 1; index >= 1; index -= 1) {
      const path = `${this.path}.${String(index)}`
      if (existsSync(path)) parts.push(readFileSync(path, 'utf8'))
    }
    if (existsSync(this.path)) parts.push(readFileSync(this.path, 'utf8'))
    return parts.join('')
  }

  /** The retained file names, for diagnostics listing. */
  files(): string[] {
    return readdirSync(this.dir)
      .filter(name => name === RotatingLog.NAME || name.startsWith(`${RotatingLog.NAME}.`))
      .sort()
      .map(name => join(this.dir, name))
  }
}

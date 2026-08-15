/**
 * Harness child-process contracts shared by the Electron main process and
 * its tests: the canonical ready line, its parser, and the chunk-tolerant
 * reader that feeds on the child's stdout.
 * @module @deepseek-ai/dsh-desktop/runtime
 */

/** The canonical ready line the web bundle logs once the server listens. */
const READY_LINE = /(?:^|\n)dsh web: http:\/\/127\.0\.0\.1:(\d+)/u

/** Global variant for scanning an accumulated buffer for every match. */
const READY_LINE_GLOBAL = new RegExp(READY_LINE.source, 'gu')

/**
 * Extract the listening port from one complete stdout line of the Harness
 * child. Lines arrive through a line reader, so the split-across-chunks
 * variant is handled by {@link ReadyLineReader} instead.
 * @param line - one complete line of child stdout.
 * @returns the loopback port, or `undefined` when the line is not the ready line.
 */
export function parseReadyLine(line: string): number | undefined {
  const match = READY_LINE.exec(line)
  return match === null ? undefined : Number(match[1])
}

/**
 * A chunk-tolerant ready-line reader: stdout arrives in arbitrary chunks
 * that may split the canonical line anywhere, with or without a trailing
 * newline. `push` accumulates and reports the port once the full line is
 * present; the buffer keeps only a bounded tail so unrelated output cannot
 * grow it without bound.
 */
export class ReadyLineReader {
  private buffer = ''

  /** The maximum buffered tail before older output is dropped. */
  static readonly MAX_BUFFER = 8192

  /**
   * Feed one stdout chunk.
   * @param chunk - one raw chunk.
   * @returns the listening port once the ready line completed, else `undefined`.
   */
  push(chunk: string): number | undefined {
    this.buffer = `${this.buffer}${chunk}`
    const match = [...this.buffer.matchAll(READY_LINE_GLOBAL)].at(-1)
    if (match !== undefined) return Number(match[1])
    if (this.buffer.length > ReadyLineReader.MAX_BUFFER) {
      this.buffer = this.buffer.slice(-ReadyLineReader.MAX_BUFFER)
    }
    return undefined
  }
}

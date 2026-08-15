import { describe, expect, it } from 'vitest'
import { ReadyLineReader, parseReadyLine } from '../src/runtime.ts'

describe('ready-line parsing', () => {
  it('extracts the loopback port from the canonical line', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:4567')).toBe(4567)
  })

  it('ignores the LAN suffix', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:4567 (LAN: http://192.168.1.5:4567)')).toBe(4567)
  })

  it('rejects unrelated output', () => {
    expect(parseReadyLine('dsh: initialized profile desktop')).toBeUndefined()
    expect(parseReadyLine('dsh web: http://[::1]:4567')).toBeUndefined()
    expect(parseReadyLine('')).toBeUndefined()
  })
})

describe('ReadyLineReader', () => {
  it('handles the line split across arbitrary chunks without a trailing newline', () => {
    const reader = new ReadyLineReader()
    expect(reader.push('some boot log\ndsh w')).toBeUndefined()
    expect(reader.push('eb: http://127.0.0.')).toBeUndefined()
    expect(reader.push('1:4567')).toBe(4567)
  })

  it('reports the port once per matched line and keeps scanning', () => {
    const reader = new ReadyLineReader()
    expect(reader.push('dsh web: http://127.0.0.1:1111\n')).toBe(1111)
    expect(reader.push('dsh web: http://127.0.0.1:2222\n')).toBe(2222)
  })

  it('bounds the buffer when the line never completes', () => {
    const reader = new ReadyLineReader()
    const junk = 'x'.repeat(ReadyLineReader.MAX_BUFFER * 2)
    expect(reader.push(junk)).toBeUndefined()
    expect(reader.push('\ndsh web: http://127.0.0.1:3333')).toBe(3333)
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTERRUPTED_CODE, OperationRegistry } from '../../src/plugins/operations.ts'

function registry(): { dir: string; ops: OperationRegistry } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-'))
  return { dir, ops: new OperationRegistry(dir) }
}

describe('OperationRegistry', () => {
  it('persists operations across instances and resumes the id counter', () => {
    const { dir, ops } = registry()
    const first = ops.enqueue('install', '@acme/fixture', '1.0.0')
    expect(first.id).toBe('1')
    expect(first.status).toBe('queued')
    ops.update(first, 'succeeded')
    const reopened = new OperationRegistry(dir)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.get('1')?.status).toBe('succeeded')
    expect(reopened.enqueue('remove', '@acme/other', '2.0.0').id).toBe('2')
  })

  it('is single-flight per package: a duplicate id returns the existing record', () => {
    const { ops } = registry()
    const first = ops.enqueue('install', '@acme/fixture', '1.0.0')
    const second = ops.enqueue('install', '@acme/fixture', '2.0.0')
    expect(second.id).toBe(first.id)
    expect(second.target).toBe('1.0.0')
    expect(ops.list()).toHaveLength(1)
    // A different kind for the same package is a distinct operation.
    const removal = ops.enqueue('remove', '@acme/fixture', '1.0.0')
    expect(removal.id).toBe('2')
    expect(ops.list()).toHaveLength(2)
  })

  it('does not let a terminal record block a fresh attempt', () => {
    const { ops } = registry()
    const first = ops.enqueue('install', '@acme/fixture', '1.0.0')
    ops.update(first, 'failed', 'scripts-not-confirmed')
    // A retry after a failure queues a new operation.
    const retry = ops.enqueue('install', '@acme/fixture', '1.0.0')
    expect(retry.id).not.toBe(first.id)
    expect(retry.status).toBe('queued')
    expect(ops.list()).toHaveLength(2)
    // While the retry is in flight, another duplicate returns it.
    ops.update(retry, 'running')
    const duplicate = ops.enqueue('install', '@acme/fixture', '1.0.0')
    expect(duplicate.id).toBe(retry.id)
  })

  it('fails interrupted queued/running records on load', () => {
    const { dir } = registry()
    writeFileSync(join(dir, 'plugin-operations.json'), JSON.stringify({
      lastId: 2,
      operations: [
        { id: '1', kind: 'install', packageName: '@acme/a', target: '1.0.0', status: 'queued', timestamp: 1 },
        { id: '2', kind: 'remove', packageName: '@acme/b', target: '2.0.0', status: 'running', timestamp: 2 },
        { id: '3', kind: 'install', packageName: '@acme/c', target: '3.0.0', status: 'restart-required', timestamp: 3 },
        { id: '4', kind: 'install', packageName: '@acme/d', target: '4.0.0', status: 'failed', timestamp: 4, code: 'launcher-failed' },
      ],
    }), 'utf8')
    const ops = new OperationRegistry(dir)
    expect(ops.get('1')?.status).toBe('failed')
    expect(ops.get('1')?.code).toBe(INTERRUPTED_CODE)
    expect(ops.get('2')?.status).toBe('failed')
    expect(ops.get('2')?.code).toBe(INTERRUPTED_CODE)
    expect(ops.get('3')?.status).toBe('restart-required')
    expect(ops.get('4')?.status).toBe('failed')
    expect(ops.get('4')?.code).toBe('launcher-failed')
  })

  it('tolerates a missing or corrupt store', () => {
    const { dir, ops } = registry()
    expect(ops.list()).toEqual([])
    writeFileSync(join(dir, 'plugin-operations.json'), '{broken', 'utf8')
    expect(new OperationRegistry(dir).list()).toEqual([])
    rmSync(dir, { recursive: true, force: true })
    expect(new OperationRegistry(dir).list()).toEqual([])
  })

  it('transitions status and records codes', () => {
    const { dir, ops } = registry()
    const op = ops.enqueue('install', '@acme/fixture', '1.0.0')
    ops.update(op, 'running')
    expect(op.status).toBe('running')
    expect(op.code).toBeUndefined()
    ops.update(op, 'failed', 'scripts-not-confirmed')
    expect(op.code).toBe('scripts-not-confirmed')
    ops.update(op, 'failed')
    expect(op.code).toBeUndefined()
    const persisted = JSON.parse(readFileSync(join(dir, 'plugin-operations.json'), 'utf8')) as { operations: Array<{ code?: string }> }
    expect(persisted.operations[0]?.code).toBeUndefined()
  })
})

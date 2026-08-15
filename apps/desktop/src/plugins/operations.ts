/**
 * The plugin-operation registry: one plugin change at a time, persisted
 * across starts, with interrupted `queued`/`running` records failing on
 * load. Duplicate operation ids return the existing record.
 * @module @deepseek-ai/dsh-desktop/plugins/operations
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  PluginOperation,
  PluginOperationCode,
  PluginOperationKind,
  PluginOperationStore,
} from './types.ts'

/** The persistence file name under the operations directory. */
const STORE_FILE = 'plugin-operations.json'

/** The interrupted-operation diagnostic code. */
export const INTERRUPTED_CODE: PluginOperationCode = 'interrupted'

/** The operation registry. */
export class OperationRegistry {
  private store: PluginOperationStore
  /** The one in-flight operation, if any (single-flight). */
  running: PluginOperation | undefined

  constructor(private readonly dir: string) {
    this.store = loadStore(join(dir, STORE_FILE))
    // Interrupted records fail on the next start; the profile was never
    // touched or the change is unverified, so they are never retried.
    for (const operation of this.store.operations) {
      if (operation.status === 'queued' || operation.status === 'running') {
        operation.status = 'failed'
        operation.code = INTERRUPTED_CODE
      }
    }
  }

  /** The persisted operations, oldest first. */
  list(): readonly PluginOperation[] {
    return [...this.store.operations]
  }

  /** The operation with the given id, if any. */
  get(id: string): PluginOperation | undefined {
    return this.store.operations.find(operation => operation.id === id)
  }

  /**
   * Queue a new operation. Only one change runs at a time: a second request
   * for the same (kind, packageName) while the first is still in flight
   * returns the existing record. Terminal records (failed, restart-required,
   * succeeded) never block a fresh attempt.
   * @param kind - install or remove.
   * @param packageName - the npm package name.
   * @param target - the exact version (install) or the installed version (remove).
   * @returns the queued operation.
   */
  enqueue(kind: PluginOperationKind, packageName: string, target: string): PluginOperation {
    const inFlight = this.store.operations.find(
      operation => operation.kind === kind && operation.packageName === packageName
        && (operation.status === 'queued' || operation.status === 'running'),
    )
    if (inFlight !== undefined) return inFlight
    this.store.lastId += 1
    const operation: PluginOperation = {
      id: String(this.store.lastId),
      kind,
      packageName,
      target,
      status: 'queued',
      timestamp: Date.now(),
    }
    this.store.operations.push(operation)
    this.persist()
    return operation
  }

  /** Transition one operation; persists and reports the change. */
  update(operation: PluginOperation, status: PluginOperation['status'], code?: PluginOperationCode): void {
    operation.status = status
    if (code === undefined) {
      delete operation.code
    } else {
      operation.code = code
    }
    operation.timestamp = Date.now()
    this.persist()
  }

  private persist(): void {
    const path = join(this.dir, STORE_FILE)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(this.store, null, 2)}\n`)
  }
}

/** Read the persisted store, tolerating absence and corruption. */
function loadStore(path: string): PluginOperationStore {
  try {
    if (!existsSync(path)) return { lastId: 0, operations: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginOperationStore
    if (typeof parsed.lastId !== 'number' || !Array.isArray(parsed.operations)) return { lastId: 0, operations: [] }
    return parsed
  } catch {
    return { lastId: 0, operations: [] }
  }
}

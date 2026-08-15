import { describe, expect, it } from 'vitest'
import {
  HarnessSupervisor,
  SUPERVISOR_CODES,
  type HarnessProcess,
  type Scheduler,
  type RuntimeStatus,
} from '../src/supervisor.ts'

/** Flush the microtask queue so queued supervisor operations run. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Deterministic scheduler: tests advance time explicitly. */
class FakeScheduler implements Scheduler {
  current = 0
  private pending: Array<{ at: number; callback: () => void }> = []

  now(): number {
    return this.current
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const job = { at: this.current + delayMs, callback }
    this.pending.push(job)
    return () => {
      this.pending = this.pending.filter(candidate => candidate !== job)
    }
  }

  advance(ms: number): void {
    this.current += ms
    const due = this.pending
      .filter(job => job.at <= this.current)
      .sort((left, right) => left.at - right.at)
    this.pending = this.pending.filter(job => job.at > this.current)
    for (const job of due) job.callback()
  }
}

/** A fake child whose lifecycle the test drives. */
class FakeProcess implements HarnessProcess {
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  private readyListeners: Array<(port: number) => void> = []
  stopped: Array<number> = []
  exited = false

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.push(listener)
    return () => {
      this.exitListeners = this.exitListeners.filter(candidate => candidate !== listener)
    }
  }

  onReady(listener: (port: number) => void): () => void {
    this.readyListeners.push(listener)
    return () => {
      this.readyListeners = this.readyListeners.filter(candidate => candidate !== listener)
    }
  }

  emitReady(port: number): void {
    for (const listener of [...this.readyListeners]) listener(port)
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true
    for (const listener of [...this.exitListeners]) listener(code, signal)
  }

  async stopTree(graceMs: number): Promise<void> {
    this.stopped.push(graceMs)
    if (!this.exited) this.emitExit(0, 'SIGTERM')
  }
}

interface Harness {
  scheduler: FakeScheduler
  supervisor: HarnessSupervisor
  spawned: FakeProcess[]
  statuses: RuntimeStatus[]
}

function makeHarness(options: { readyTimeoutMs?: number; crashWindowMs?: number; maxCrashes?: number } = {}): Harness {
  const scheduler = new FakeScheduler()
  const spawned: FakeProcess[] = []
  const statuses: RuntimeStatus[] = []
  const supervisor = new HarnessSupervisor({
    spawn: () => {
      const process = new FakeProcess()
      spawned.push(process)
      return process
    },
    restartDelays: [1, 2, 4, 8, 16],
    crashWindowMs: options.crashWindowMs ?? 120_000,
    maxCrashes: options.maxCrashes ?? 5,
    readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
    onStatus: (status) => { statuses.push(status) },
    scheduler,
  })
  return { scheduler, supervisor, spawned, statuses }
}

describe('HarnessSupervisor', () => {
  it('starts into ready when the child reports the port', async () => {
    const { supervisor, spawned, statuses } = makeHarness()
    const started = supervisor.start()
    await settle()
    expect(supervisor.status().state).toBe('starting')
    spawned[0]?.emitReady(4321)
    await started
    expect(supervisor.status().state).toBe('ready')
    expect(statuses.map(status => status.state)).toEqual(['starting', 'ready'])
  })

  it('counts a ready timeout as an unexpected failure and restarts after the ladder', async () => {
    const { scheduler, supervisor, spawned } = makeHarness({ readyTimeoutMs: 10_000 })
    const started = supervisor.start()
    await settle()
    scheduler.advance(10_000)
    await started
    expect(supervisor.status().state).toBe('restarting')
    expect(supervisor.status().restartCount).toBe(1)
    expect(spawned[0]?.stopped).toEqual([1_000])
    scheduler.advance(1_000)
    await settle()
    expect(supervisor.status().state).toBe('starting')
    expect(spawned).toHaveLength(2)
  })

  it('restarts on the 1, 2, 4, 8 second ladder and trips failed on the fifth crash', async () => {
    const { scheduler, supervisor, spawned } = makeHarness()
    const first = supervisor.start()
    await settle()
    spawned[0]?.emitReady(1)
    await first
    const delays: number[] = []
    for (let crash = 1; crash <= 4; crash += 1) {
      spawned.at(-1)?.emitExit(1, null)
      expect(supervisor.status().state).toBe('restarting')
      const before = spawned.length
      const delay = [1000, 2000, 4000, 8000][crash - 1] as number
      delays.push(delay)
      scheduler.advance(delay)
      await settle()
      expect(spawned.length).toBe(before + 1)
      spawned.at(-1)?.emitReady(crash + 1)
      await settle()
      expect(supervisor.status().state).toBe('ready')
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000])
    // Fifth unexpected exit inside the window: failed, no further spawns.
    spawned.at(-1)?.emitExit(1, null)
    expect(supervisor.status().state).toBe('failed')
    expect(supervisor.status().code).toBe(SUPERVISOR_CODES.crashLimit)
    scheduler.advance(120_000)
    await settle()
    expect(spawned.length).toBe(5)
  })

  it('prunes crash timestamps outside the window', async () => {
    const { scheduler, supervisor, spawned } = makeHarness({ crashWindowMs: 10_000 })
    const first = supervisor.start()
    await settle()
    spawned[0]?.emitReady(1)
    await first
    // One crash inside a fresh window, then each next crash starts a new
    // window: the counter never reaches the cutoff.
    for (let crash = 1; crash <= 6; crash += 1) {
      spawned.at(-1)?.emitExit(1, null)
      expect(supervisor.status().state).toBe('restarting')
      scheduler.advance([1000, 2000, 4000, 8000, 16000, 16000][crash - 1] as number)
      await settle()
      spawned.at(-1)?.emitReady(crash + 1)
      await settle()
      scheduler.advance(11_000) // every crash lands outside the previous window
    }
    spawned.at(-1)?.emitExit(1, null)
    expect(supervisor.status().state).toBe('restarting')
    expect(spawned.length).toBe(7)
  })

  it('serializes concurrent start and restart calls', async () => {
    const { supervisor, spawned } = makeHarness()
    const first = supervisor.start()
    await settle()
    spawned[0]?.emitReady(1)
    await first
    const restartA = supervisor.restart()
    const restartB = supervisor.restart()
    await settle()
    // The first restart stops the live child and boots; the second queues.
    spawned.at(-1)?.emitReady(2)
    await settle()
    spawned.at(-1)?.emitReady(3)
    await Promise.all([restartA, restartB])
    expect(supervisor.status().state).toBe('ready')
    expect(spawned.length).toBe(3)
  })

  it('stops to quiescence and ignores exits during stopping', async () => {
    const { supervisor, spawned } = makeHarness()
    const started = supervisor.start()
    await settle()
    spawned[0]?.emitReady(1)
    await started
    const stopped = supervisor.stop()
    await stopped
    expect(supervisor.status().state).toBe('idle')
    expect(supervisor.status().restartCount).toBe(0)
    expect(spawned[0]?.stopped).toEqual([5_000])
  })

  it('start is a no-op while active', async () => {
    const { supervisor, spawned } = makeHarness()
    const started = supervisor.start()
    await settle()
    spawned[0]?.emitReady(1)
    await started
    await supervisor.start()
    expect(spawned).toHaveLength(1)
    expect(supervisor.status().state).toBe('ready')
  })

  it('recovers from failed via restart', async () => {
    const { scheduler, supervisor, spawned } = makeHarness({ maxCrashes: 2 })
    const started = supervisor.start()
    await settle()
    spawned[0]?.emitReady(1)
    await started
    spawned.at(-1)?.emitExit(1, null)
    scheduler.advance(1_000)
    await settle()
    spawned.at(-1)?.emitReady(2)
    await settle()
    spawned.at(-1)?.emitExit(1, null)
    expect(supervisor.status().state).toBe('failed')
    const restarted = supervisor.restart()
    await settle()
    spawned.at(-1)?.emitReady(3)
    await restarted
    expect(supervisor.status().state).toBe('ready')
  })
})

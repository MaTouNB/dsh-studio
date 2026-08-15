/**
 * The serialized Harness lifecycle supervisor: one child process, states
 * `idle | starting | ready | restarting | stopping | failed`, bounded crash
 * recovery, and a quit that reaches quiescence. Start and stop operations
 * queue on one tail so concurrent requests serialize; unexpected exits
 * restart on a delay ladder until the crash-window cutoff trips `failed`.
 * Pure of Electron: processes and timers are injected, so tests pin the
 * whole state machine with fakes.
 * @module @deepseek-ai/dsh-desktop/supervisor
 */

/** The lifecycle states the Desktop exposes to its UI. */
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'failed'

/** Safe status for the renderer and the log: state, restarts, and a code. */
export interface RuntimeStatus {
  state: RuntimeState
  /** Unexpected exits since the last explicit stop (the restart count). */
  restartCount: number
  /** Optional safe diagnostic code; never a raw exception or child output. */
  code?: string
  timestamp: number
}

/** One supervised Harness child as seen by the supervisor. */
export interface HarnessProcess {
  /** Whether the process has exited. */
  readonly exited: boolean
  /** Attach a one-shot exit listener; returns the detacher. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  /** Attach a one-shot ready listener fired once with the listening port. */
  onReady(listener: (port: number) => void): () => void
  /** Terminate the process tree and resolve once nothing of it is alive. */
  stopTree(graceMs: number): Promise<void>
}

/** A timer scheduler, injectable for deterministic tests. */
export interface Scheduler {
  schedule(delayMs: number, callback: () => void): () => void
  now(): number
}

/** Dependencies the supervisor needs from its host. */
export interface SupervisorOptions {
  /** Spawn one fresh Harness child. */
  spawn(): HarnessProcess
  /** Restart delay ladder, in seconds, cycled by crash ordinal. */
  restartDelays: readonly number[]
  /** A rolling window; this many unexpected exits inside it trips `failed`. */
  crashWindowMs: number
  /** Unexpected exits inside the window that trip `failed`. */
  maxCrashes: number
  /** How long a child may take to become ready before it counts as crashed. */
  readyTimeoutMs: number
  /** Status change notifications (the log, the IPC broadcast, the UI). */
  onStatus(status: RuntimeStatus): void
  /** Timer injection for deterministic tests. */
  scheduler?: Scheduler
}

const REAL_SCHEDULER: Scheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs)
    return () => { clearTimeout(timer) }
  },
  now() {
    return Date.now()
  },
}

/** Diagnostic codes that may appear on a `RuntimeStatus`. */
export const SUPERVISOR_CODES = {
  /** The child never printed the ready line inside the timeout. */
  readyTimeout: 'ready-timeout',
  /** Too many unexpected exits inside the crash window. */
  crashLimit: 'crash-limit',
} as const

/** The supervisor. Every public operation is a transition on the tail. */
export class HarnessSupervisor {
  private state: RuntimeState = 'idle'
  private restartCount = 0
  private crashTimes: number[] = []
  private tail: Promise<void> = Promise.resolve()
  private child: HarnessProcess | undefined
  private code: string | undefined

  constructor(private readonly options: SupervisorOptions) {}

  /** The current status snapshot. */
  status(): RuntimeStatus {
    return {
      state: this.state,
      restartCount: this.restartCount,
      ...(this.code === undefined ? {} : { code: this.code }),
      timestamp: this.scheduler().now(),
    }
  }

  /** Start the child from `idle` or `failed`; no-op while active. */
  start(): Promise<RuntimeStatus> {
    return this.enqueue(async () => {
      if (this.state !== 'idle' && this.state !== 'failed') return
      this.code = undefined
      await this.boot()
    })
  }

  /** Stop the child and return to `idle`; resolves at quiescence. */
  stop(): Promise<RuntimeStatus> {
    return this.enqueue(async () => {
      if (this.state === 'stopping') return
      if (this.child === undefined) {
        if (this.state === 'failed' || this.state === 'restarting') this.transition('idle')
        this.restartCount = 0
        this.crashTimes = []
        return
      }
      this.transition('stopping')
      const child = this.child
      this.child = undefined
      await child.stopTree(5_000)
      this.restartCount = 0
      this.crashTimes = []
      this.transition('idle')
    })
  }

  /** Stop, then start: the UI restart action and the plugin-reload path. */
  restart(): Promise<RuntimeStatus> {
    return this.enqueue(async () => {
      if (this.child !== undefined) {
        this.transition('stopping')
        const child = this.child
        this.child = undefined
        await child.stopTree(5_000)
        this.restartCount = 0
        this.crashTimes = []
      } else if (this.state === 'failed' || this.state === 'restarting') {
        this.transition('idle')
      }
      this.code = undefined
      await this.boot()
    })
  }

  private scheduler(): Scheduler {
    return this.options.scheduler ?? REAL_SCHEDULER
  }

  private enqueue(operation: () => Promise<void>): Promise<RuntimeStatus> {
    this.tail = this.tail.then(operation)
    return this.tail.then(() => this.status())
  }

  private transition(state: RuntimeState): void {
    this.state = state
    this.options.onStatus(this.status())
  }

  private async boot(): Promise<void> {
    this.transition('starting')
    const child = this.options.spawn()
    this.child = child
    child.onExit(() => {
      if (this.child !== child) return
      this.handleUnexpectedExit()
    })
    const ready = await new Promise<boolean>((resolve) => {
      let done = false
      const finish = (value: boolean): void => {
        if (done) return
        done = true
        resolve(value)
      }
      child.onReady(() => { finish(true) })
      this.scheduler().schedule(this.options.readyTimeoutMs, () => { finish(false) })
    })
    if (this.child !== child) return // a stop overtook the boot
    if (ready) {
      this.transition('ready')
      return
    }
    // A live child that never became ready counts as an unexpected failure.
    // A child that died during boot was already counted by its exit listener,
    // and stopTree on an exited child is a no-op.
    await child.stopTree(1_000)
    if (this.child !== child) return
    if (!child.exited) this.handleUnexpectedExit()
  }

  /** One unexpected exit (or ready timeout): window accounting, ladder, cutoff. */
  private handleUnexpectedExit(): void {
    if (this.state === 'stopping' || this.state === 'idle') return
    const now = this.scheduler().now()
    this.crashTimes.push(now)
    const windowStart = now - this.options.crashWindowMs
    while (this.crashTimes.length > 0 && (this.crashTimes[0] as number) < windowStart) this.crashTimes.shift()
    this.restartCount += 1
    if (this.crashTimes.length >= this.options.maxCrashes) {
      this.code = SUPERVISOR_CODES.crashLimit
      this.transition('failed')
      return
    }
    const ordinal = Math.min(this.crashTimes.length, this.options.restartDelays.length) - 1
    const delayMs = (this.options.restartDelays[ordinal] as number) * 1000
    this.transition('restarting')
    this.scheduler().schedule(delayMs, () => {
      if (this.state !== 'restarting') return
      // Resume directly: start() only boots from idle or failed.
      void this.enqueue(async () => { await this.boot() })
    })
  }
}

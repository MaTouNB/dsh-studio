/**
 * DSH Studio Electron main (M2/M3): the serialized Harness lifecycle
 * supervisor, per-launch loopback authentication, rotating redacted logs,
 * diagnostic export, and the plugin-management host (GitHub discovery,
 * npm correspondence, exact-version installs and safe removal), with the
 * sandboxed window and typed IPC surface. The child runs under the bundled
 * stock Node against the dedicated `desktop` profile; the window bootstraps
 * its per-launch cookie and never leaves the active loopback origin.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { BOOTSTRAP_PATH, SECRET_ENV } from '@deepseek-ai/dsh-desktop-integration/auth'
import { DESKTOP_PROFILE, ensureDesktopProfile } from './profile.ts'
import { PRODUCT_NAME } from './product.ts'
import { ReadyLineReader } from './runtime.ts'
import { RotatingLog, type LogFields } from './logging.ts'
import { diagnosticEntries, profilePackages, writeDiagnosticZip } from './diagnostics.ts'
import { HarnessSupervisor, type HarnessProcess, type RuntimeStatus } from './supervisor.ts'
import { GitHubClient } from './plugins/github.ts'
import { NpmClient } from './plugins/npm.ts'
import { OperationRegistry } from './plugins/operations.ts'
import { PluginManager } from './plugins/manager.ts'

/** The bootstrap URL the window opens on readiness (test hook prints it). */
const ECHO_BOOTSTRAP_ENV = 'DSH_STUDIO_ECHO_BOOTSTRAP'

/** The per-launch secret: 256 random bits as base64url. */
const secret = randomBytes(32).toString('base64url')

const appVersion = app.getVersion()
const harnessVersion = resolveHarnessVersion()
const logDir = app.getPath('logs')
const rotatingLog = new RotatingLog(logDir, credentialSecrets())
let supervisor: HarnessSupervisor | undefined
let mainWindow: BrowserWindow | undefined
let activeOrigin: string | undefined
let quitting = false
let failedActionsShown = false
let pluginManager: PluginManager | undefined

/** The repository root when running from a source checkout. */
function repoRoot(): string {
  return resolve(join(app.getAppPath(), '..', '..'))
}

/** The bundled Harness version, from the staged runtime manifest. */
function resolveHarnessVersion(): string {
  try {
    if (app.isPackaged) {
      const manifest = JSON.parse(readFileSync(join(process.resourcesPath, 'runtime', 'runtime-manifest.json'), 'utf8')) as {
        components?: { dsh?: { version?: string } }
      }
      return manifest.components?.dsh?.version ?? 'unknown'
    }
    return (JSON.parse(readFileSync(join(repoRoot(), 'apps', 'cli', 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Values every log line is scrubbed of: the secret plus env credential values. */
function credentialSecrets(): string[] {
  const values = Object.entries(process.env)
    .filter(([name]) => /(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))
    .map(([, value]) => value ?? '')
  return [secret, ...values]
}

/** Write one redacted log line with the current lifecycle state. */
function log(stream: LogFields['stream'], message: string): void {
  rotatingLog.append({
    time: new Date().toISOString(),
    stream,
    appVersion,
    harnessVersion,
    state: supervisor?.status().state ?? 'idle',
    message,
  })
}

/** The node binary, dsh entry, and working directory for the Harness child. */
function harnessCommand(): { nodeBin: string; entry: string; cwd: string } {
  if (app.isPackaged) {
    const runtime = join(process.resourcesPath, 'runtime')
    return {
      nodeBin: join(runtime, 'node', 'bin', 'node'),
      entry: join(runtime, 'dsh-cli', 'lib', 'bin.js'),
      cwd: join(runtime, 'dsh-cli'),
    }
  }
  return {
    nodeBin: process.env.DSH_STUDIO_NODE ?? 'node',
    entry: join(repoRoot(), 'apps', 'cli', 'lib', 'bin.js'),
    cwd: repoRoot(),
  }
}

/** The DSH home, matching `dsh-home-paths` precedence: `$DSH_HOME`, then `~/.dsh`. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** In dev, make the desktop-owned packages resolvable from the profile's node_modules. */
function linkDevIntegrationBundle(home: string): void {
  const linkDir = join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai')
  const links: Array<[string, string]> = [
    ['dsh-desktop-integration', join(repoRoot(), 'apps', 'desktop', 'bundle')],
    ['dsh-client-ui-settings-plugin-center', join(repoRoot(), 'packages', 'client', 'ui-settings-plugin-center')],
  ]
  for (const [name, target] of links) {
    const link = join(linkDir, name)
    if (existsSync(link) || !existsSync(join(target, 'lib', 'index.js'))) continue
    try {
      mkdirSync(linkDir, { recursive: true })
      symlinkSync(target, link)
    } catch (error) {
      log('app', `dev integration bundle link failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Spawn one Harness child and expose it to the supervisor. */
function spawnHarnessProcess(): HarnessProcess {
  const home = dshHome()
  ensureDesktopProfile(home)
  if (!app.isPackaged) linkDevIntegrationBundle(home)
  const { nodeBin, entry, cwd } = harnessCommand()
  const child: ChildProcess = spawn(nodeBin, [entry, '--profile', 'desktop', '--port', '0'], {
    cwd,
    env: { ...process.env, DSH_HOME: home, [SECRET_ENV]: secret },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const reader = new ReadyLineReader()
  const readyListeners: Array<(port: number) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  let readyNotified = false
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk)
    log('stdout', text.trimEnd())
    const port = reader.push(text)
    if (port !== undefined && !readyNotified) {
      readyNotified = true
      for (const listener of [...readyListeners]) listener(port)
    }
  })
  child.stderr?.on('data', (chunk) => { log('stderr', String(chunk).trimEnd()) })
  child.on('exit', (code, signal) => {
    for (const listener of [...exitListeners]) listener(code, signal)
  })
  return {
    get exited(): boolean {
      return child.exitCode !== null || child.signalCode !== null
    },
    onExit(listener) {
      exitListeners.push(listener)
      return () => {
        const at = exitListeners.indexOf(listener)
        if (at !== -1) exitListeners.splice(at, 1)
      }
    },
    onReady(listener) {
      readyListeners.push(listener)
      return () => {
        const at = readyListeners.indexOf(listener)
        if (at !== -1) readyListeners.splice(at, 1)
      }
    },
    async stopTree(graceMs) {
      if (child.pid === undefined) return
      const pid = child.pid
      const exited = new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
      const alive = child.exitCode === null && child.signalCode === null
      if (alive) {
        if (process.platform === 'win32') {
          child.kill('SIGTERM')
        } else {
          try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
        }
      }
      await Promise.race([
        exited,
        new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, graceMs)),
      ])
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          child.kill('SIGKILL')
        } else {
          try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
      await exited
    },
  }
}

/** Open (or refresh) the window on the authenticated bootstrap URL. */
function openWindow(port: number): void {
  activeOrigin = `http://127.0.0.1:${String(port)}`
  const bootstrapUrl = `${activeOrigin}${BOOTSTRAP_PATH}?token=${encodeURIComponent(secret)}`
  if (process.env[ECHO_BOOTSTRAP_ENV] === '1') {
    console.log(`[studio] bootstrap ${bootstrapUrl}`)
  }
  if (mainWindow === undefined) {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(app.getAppPath(), 'lib', 'preload.cjs'),
      },
    })
    // Only the active loopback origin may load; everything else is a
    // navigation attempt the shell must reject.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (activeOrigin !== undefined && !url.startsWith(activeOrigin)) event.preventDefault()
    })
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/iu.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    mainWindow.on('closed', () => { mainWindow = undefined })
  }
  void mainWindow.loadURL(bootstrapUrl)
}

/** Verify an IPC sender: our window's frame, on the active loopback origin. */
function assertSender(event: IpcMainInvokeEvent): void {
  if (mainWindow === undefined || event.sender !== mainWindow.webContents) {
    throw new Error('dsh-studio: IPC from an unexpected sender')
  }
  if (event.senderFrame === null) throw new Error('dsh-studio: IPC without a sender frame')
  const origin = new URL(event.senderFrame.url).origin
  if (origin !== activeOrigin) {
    throw new Error('dsh-studio: IPC sender outside the active loopback origin')
  }
}

/** Build and save the diagnostic zip to `target`. */
function buildDiagnostics(target: string): void {
  const home = dshHome()
  const manifestPath = app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'runtime-manifest.json')
    : join(repoRoot(), 'apps', 'desktop', 'staging', 'mac-arm64', 'runtime-manifest.json')
  const entries = diagnosticEntries({
    appVersion,
    harnessVersion,
    platform: process.platform,
    arch: process.arch,
    release: process.getSystemVersion(),
    state: supervisor?.status().state ?? 'idle',
    logDir,
    profileDir: join(home, 'profiles', DESKTOP_PROFILE),
    runtimeManifest: readJson(manifestPath),
    profilePackages: profilePackages(join(home, 'profiles', DESKTOP_PROFILE)),
  }, rotatingLog.readAll())
  writeDiagnosticZip(target, entries)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The failed state's native actions: retry, logs, diagnostics, quit. */
async function showFailedActions(status: RuntimeStatus): Promise<void> {
  if (failedActionsShown || mainWindow === undefined) return
  failedActionsShown = true
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: PRODUCT_NAME,
    message: 'The managed Harness keeps crashing.',
    ...(status.code === undefined ? {} : { detail: `Diagnostic code: ${status.code}` }),
    buttons: ['Retry', 'Open Logs', 'Export Diagnostics', 'Quit'],
    defaultId: 0,
    cancelId: 3,
  })
  if (choice.response === 0) {
    failedActionsShown = false
    void supervisor?.start()
  } else if (choice.response === 1) {
    void shell.openPath(logDir)
  } else if (choice.response === 2) {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `dsh-studio-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.zip`,
      filters: [{ name: 'zip', extensions: ['zip'] }],
    })
    if (!result.canceled) {
      try {
        buildDiagnostics(result.filePath)
      } catch (error) {
        dialog.showErrorBox(PRODUCT_NAME, `Diagnostic export failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } else {
    void shutdown()
  }
}

/** Status changes: log, broadcast to the renderer, and act on `failed`. */
function onStatus(status: RuntimeStatus): void {
  log('state', status.state)
  mainWindow?.webContents.send('dsh-studio:status', status)
  if (status.state === 'failed') void showFailedActions(status)
}

/** Stop the child tree and quit the app. */
async function shutdown(): Promise<void> {
  if (quitting || supervisor === undefined) return
  quitting = true
  await supervisor.stop()
  app.quit()
}

/** The typed IPC surface, every handler sender-verified. */
function registerIpc(): void {
  ipcMain.handle('dsh-studio:get-info', (event) => {
    assertSender(event)
    return {
      appVersion,
      harnessVersion,
      platform: process.platform,
      arch: process.arch,
      profile: DESKTOP_PROFILE,
      logDir,
      state: supervisor?.status().state ?? 'idle',
    }
  })
  ipcMain.handle('dsh-studio:restart-harness', async (event) => {
    assertSender(event)
    return supervisor?.restart() ?? { state: 'idle' as const, restartCount: 0, timestamp: Date.now() }
  })
  ipcMain.handle('dsh-studio:open-logs', async (event) => {
    assertSender(event)
    await shell.openPath(logDir)
  })
  ipcMain.handle('dsh-studio:export-diagnostics', async (event) => {
    assertSender(event)
    const result = await dialog.showSaveDialog(mainWindow as BrowserWindow, {
      defaultPath: `dsh-studio-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.zip`,
      filters: [{ name: 'zip', extensions: ['zip'] }],
    })
    if (result.canceled) return { canceled: true }
    try {
      buildDiagnostics(result.filePath)
    } catch (error) {
      dialog.showErrorBox(PRODUCT_NAME, `Diagnostic export failed: ${error instanceof Error ? error.message : String(error)}`)
      return { canceled: true }
    }
    return { canceled: false, path: result.filePath }
  })
  ipcMain.handle('dsh-studio:search-plugins', (event, request: unknown) => {
    assertSender(event)
    return managerOrThrow().search(validateSearchRequest(request))
  })
  ipcMain.handle('dsh-studio:inspect-plugin', (event, request: unknown) => {
    assertSender(event)
    return managerOrThrow().inspect(validateInspectRequest(request))
  })
  ipcMain.handle('dsh-studio:install-plugin', (event, request: unknown) => {
    assertSender(event)
    return managerOrThrow().install(validateInstallRequest(request))
  })
  ipcMain.handle('dsh-studio:remove-plugin', (event, request: unknown) => {
    assertSender(event)
    return managerOrThrow().remove(validateRemoveRequest(request))
  })
  ipcMain.handle('dsh-studio:list-plugin-operations', (event) => {
    assertSender(event)
    return managerOrThrow().listOperations()
  })
  ipcMain.handle('dsh-studio:list-installed-plugins', (event) => {
    assertSender(event)
    return managerOrThrow().listInstalled()
  })
}

/** The plugin manager, created once the app paths are known. */
function managerOrThrow(): PluginManager {
  if (pluginManager !== undefined) return pluginManager
  const home = dshHome()
  ensureDesktopProfile(home)
  const userDataDir = app.getPath('userData')
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(repoRoot(), 'apps', 'desktop', 'staging', 'mac-arm64')
  const dshEntry = join(runtime, 'dsh-cli', 'lib', 'bin.js')
  const nodeBin = join(runtime, 'node', 'bin', 'node')
  const pnpmEntry = join(runtime, 'pnpm', 'bin', 'pnpm.cjs')
  const operations = new OperationRegistry(join(userDataDir, 'plugin-operations'))
  pluginManager = new PluginManager({
    github: new GitHubClient({
      fetchFn: fetch,
      cacheDir: join(userDataDir, 'github-cache'),
    }),
    npm: new NpmClient(fetch),
    operations,
    profileDir: join(home, 'profiles', DESKTOP_PROFILE),
    dshEntry,
    nodeBin,
    pnpmEntry,
    userDataDir,
    launcherTimeoutMs: 300_000,
    onOperation: (operation) => {
      mainWindow?.webContents.send('dsh-studio:plugin-operation', operation)
    },
  })
  return pluginManager
}

/** Bounded validation for the plugin IPC inputs (renderer input never reaches argv unvalidated). */
function validateSearchRequest(request: unknown): { query: string; page: number } {
  const value = request as { query?: unknown; page?: unknown }
  if (typeof value.query !== 'string' || value.query.length > 200) throw new Error('dsh-studio: invalid search query')
  const page = typeof value.page === 'number' && Number.isInteger(value.page) && value.page >= 1 && value.page <= 100 ? value.page : 1
  return { query: value.query, page }
}

function validateInspectRequest(request: unknown): { owner: string; name: string } {
  const value = request as { owner?: unknown; name?: unknown }
  if (typeof value.owner !== 'string' || !/^[A-Za-z0-9-]+$/u.test(value.owner)) throw new Error('dsh-studio: invalid owner')
  if (typeof value.name !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(value.name)) throw new Error('dsh-studio: invalid repo name')
  return { owner: value.owner, name: value.name }
}

function validateInstallRequest(request: unknown): { packageName: string; version: string; allowScripts: boolean } {
  const value = request as { packageName?: unknown; version?: unknown; allowScripts?: unknown }
  if (typeof value.packageName !== 'string') throw new Error('dsh-studio: invalid package name')
  if (typeof value.version !== 'string') throw new Error('dsh-studio: invalid version')
  if (typeof value.allowScripts !== 'boolean') throw new Error('dsh-studio: invalid allowScripts')
  return { packageName: value.packageName, version: value.version, allowScripts: value.allowScripts }
}

function validateRemoveRequest(request: unknown): { packageName: string } {
  const value = request as { packageName?: unknown }
  if (typeof value.packageName !== 'string') throw new Error('dsh-studio: invalid package name')
  return { packageName: value.packageName }
}

void (async () => {
  await app.whenReady()
  supervisor = new HarnessSupervisor({
    // the window opens when a spawned child reports its listening port; the
    // supervisor's readiness and the window are separate concerns.
    spawn: () => {
      const process = spawnHarnessProcess()
      process.onReady(openWindow)
      return process
    },
    restartDelays: [1, 2, 4, 8, 16],
    crashWindowMs: 120_000,
    maxCrashes: 5,
    readyTimeoutMs: 60_000,
    onStatus,
  })
  registerIpc()
  await supervisor.start()
  app.on('window-all-closed', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
})()

/**
 * The sandboxed preload: one frozen `window.dshStudio` object exposing the
 * runtime actions, the plugin-management operations, and the status
 * subscriptions. The bundle compiles this to a single CJS file (sandboxed
 * preloads cannot be ESM); every handler runs in the main process, which
 * validates the input and verifies the sender frame before acting.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

interface DesktopInfo {
  appVersion: string
  harnessVersion: string
  platform: string
  arch: string
  profile: string
  logDir: string
  state: string
}

interface RuntimeStatus {
  state: string
  restartCount: number
  code?: string
  timestamp: number
}

interface PluginSearchRequest {
  query: string
  page: number
}

interface PluginInspectRequest {
  owner: string
  name: string
}

interface PluginInstallRequest {
  packageName: string
  version: string
  allowScripts: boolean
}

interface PluginRemoveRequest {
  packageName: string
}

/** The frozen bridge object. */
const api = Object.freeze({
  getInfo: (): Promise<DesktopInfo> => ipcRenderer.invoke('dsh-studio:get-info'),
  restartHarness: (): Promise<RuntimeStatus> => ipcRenderer.invoke('dsh-studio:restart-harness'),
  openLogs: (): Promise<void> => ipcRenderer.invoke('dsh-studio:open-logs'),
  exportDiagnostics: (): Promise<{ canceled: boolean; path?: string }> =>
    ipcRenderer.invoke('dsh-studio:export-diagnostics'),
  searchPlugins: (request: PluginSearchRequest): Promise<unknown> =>
    ipcRenderer.invoke('dsh-studio:search-plugins', request),
  inspectPlugin: (request: PluginInspectRequest): Promise<unknown> =>
    ipcRenderer.invoke('dsh-studio:inspect-plugin', request),
  installPlugin: (request: PluginInstallRequest): Promise<unknown> =>
    ipcRenderer.invoke('dsh-studio:install-plugin', request),
  removePlugin: (request: PluginRemoveRequest): Promise<unknown> =>
    ipcRenderer.invoke('dsh-studio:remove-plugin', request),
  listPluginOperations: (): Promise<unknown> =>
    ipcRenderer.invoke('dsh-studio:list-plugin-operations'),
  listInstalledPlugins: (): Promise<unknown> =>
    ipcRenderer.invoke('dsh-studio:list-installed-plugins'),
  onRuntimeStatus: (listener: (status: RuntimeStatus) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: RuntimeStatus): void => { listener(status) }
    ipcRenderer.on('dsh-studio:status', wrapped)
    return () => { ipcRenderer.removeListener('dsh-studio:status', wrapped) }
  },
  onPluginOperation: (listener: (operation: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, operation: unknown): void => { listener(operation) }
    ipcRenderer.on('dsh-studio:plugin-operation', wrapped)
    return () => { ipcRenderer.removeListener('dsh-studio:plugin-operation', wrapped) }
  },
})

contextBridge.exposeInMainWorld('dshStudio', api)

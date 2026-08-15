/**
 * Browser coverage for the desktop plugin-center tabs (M4): the assembled
 * Web surface gains the Discover / Manage tabs through the desktop-only
 * overlay row, and the window.dshStudio bridge is stubbed with a stateful
 * mock that persists across page reloads (mirroring the real operation
 * persistence and restart cycle). The scenario drives the full acceptance
 * loop — search, inspect, script-confirmed install, restart prompt, manifest
 * verification after a simulated restart, removal, and a second restart —
 * and the golden pins the assembled Plugins tablist with the new tabs.
 */
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plugin-center', import.meta.url))
const TABS_EXPECTED = join(SNAPSHOT_DIR, 'tabs.expected.md')
const OVERLAY = fileURLToPath(new URL('./plugin-center.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

/** Seed the window.dshStudio mock; state survives reloads via localStorage. */
const BRIDGE_STUB = `
(() => {
  const LS = 'pluginCenter.mock'
  const listeners = new Set()
  let seq = 0
  const read = () => JSON.parse(localStorage.getItem(LS) ?? '{"installed":[],"pending":[]}')
  const write = (state) => localStorage.setItem(LS, JSON.stringify(state))
  const HIT = {
    repo: { owner: 'acme', name: 'agent-search' },
    description: 'Agent search plugin',
    stars: 42,
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/acme/agent-search',
  }
  const CANDIDATE = {
    repo: HIT.repo,
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    packageName: '@acme/agent-search',
    license: 'MIT',
    npmVersion: '1.2.3',
    publishedAt: '2026-01-01T00:00:00.000Z',
    scriptNeeds: { scripts: ['postinstall'], nativeBuild: false },
    installable: true,
    sourceUrl: 'https://github.com/acme/agent-search',
  }
  const op = (kind, packageName, target, status, code) => {
    const value = { id: 'op-' + String(++seq), kind, packageName, target, status, timestamp: Date.now() }
    if (code !== undefined) value.code = code
    return value
  }
  const emit = (next) => { for (const listener of listeners) listener(next) }
  window.dshStudio = {
    getInfo: async () => ({ appVersion: '0.1.0', harnessVersion: '0.1.0', platform: 'darwin', arch: 'arm64', profile: 'desktop', logDir: '/tmp', state: 'ready' }),
    restartHarness: async () => {
      const state = read()
      for (const change of state.pending) {
        if (change.kind === 'install') state.installed.push(change)
        else state.installed = state.installed.filter((entry) => entry.packageName !== change.packageName)
      }
      state.pending = []
      write(state)
      return { state: 'restarting', restartCount: 1, timestamp: Date.now() }
    },
    openLogs: async () => {},
    exportDiagnostics: async () => ({ canceled: true }),
    searchPlugins: async ({ query }) => ({
      hits: query.trim() === '' ? [] : [HIT],
      rateLimit: { remaining: 49, resetAt: '2026-01-02T00:00:00.000Z' },
    }),
    inspectPlugin: async () => CANDIDATE,
    installPlugin: async ({ packageName, version }) => {
      const state = read()
      state.pending.push({ kind: 'install', packageName, version, bundle: true })
      write(state)
      const first = op('install', packageName, version, 'queued')
      emit(first)
      queueMicrotask(() => emit({ ...first, status: 'restart-required' }))
      return first
    },
    removePlugin: async ({ packageName }) => {
      const state = read()
      state.pending.push({ kind: 'remove', packageName })
      write(state)
      const first = op('remove', packageName, '1.2.3', 'queued')
      emit(first)
      queueMicrotask(() => emit({ ...first, status: 'restart-required' }))
      return first
    },
    listInstalledPlugins: async () => read().installed,
    listPluginOperations: async () => [],
    onRuntimeStatus: () => () => {},
    onPluginOperation: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
})()
`

describe('web e2e: desktop plugin center tabs', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    mkdirSync(SNAPSHOT_DIR, { recursive: true })
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.addInitScript(BRIDGE_STUB)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Open Settings → Plugins and return the dialog locator. */
  async function openPluginsSection(): Promise<ReturnType<Page['getByRole']>> {
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    await trigger.waitFor({ state: 'visible', timeout: 30_000 })
    await trigger.click({ timeout: 30_000 })
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
    return dialog
  }

  it('shows the Discover and Manage tabs in the assembled Plugins section', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-center-tabs'))
    const dialog = await openPluginsSection()
    const tablist = dialog.getByRole('tablist')
    await tablist.getByRole('tab', { name: '发现', exact: true }).waitFor({ timeout: 10_000 })
    await tablist.getByRole('tab', { name: '管理', exact: true }).waitFor()
    // The shipped tabs remain: configuration and inventory.
    await tablist.getByRole('tab', { name: '插件配置', exact: true }).waitFor()
    await tablist.getByRole('tab', { name: '插件列表', exact: true }).waitFor()
    // The assembled snapshot: the Plugins tablist carries the new tabs.
    const snapshot = await captureStableAria(page, '[role="tablist"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(TABS_EXPECTED, snapshot, MODE)
    // Leave the shell closed for the flow scenario that follows.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 10_000 }).toBe(0)
  }, 60_000)

  it('installs with script confirmation, verifies after restart, removes, and verifies again', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-center-flow'))
    // Discover: search → inspect → install with the script confirmation.
    let dialog = await openPluginsSection()
    await dialog.getByRole('tab', { name: '发现', exact: true }).click()
    const search = dialog.getByRole('searchbox', { name: '搜索插件' })
    await search.fill('agent')
    await dialog.getByRole('button', { name: '搜索' }).click()
    await dialog.getByText('acme/agent-search', { exact: false }).first().waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /acme\/agent-search/ }).click()
    await dialog.getByText('@acme/agent-search').waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '安装', exact: true }).click()
    await dialog.getByRole('dialog', { name: '允许安装脚本？' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '允许并安装' }).click()
    await dialog.getByRole('dialog', { name: '重启后生效' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '重启', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '重启后生效' }).count(), { timeout: 10_000 }).toBe(0)

    // Simulated restart: close the settings dialog first so the reloaded
    // page (bfcache-restored) starts with the shell closed, then the mock
    // applies the install on the next boot.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 10_000 }).toBe(0)
    // Simulated restart: a fresh navigation (cache-busting query avoids the
    // bfcache restoring the open dialog) re-runs the boot, and the mock
    // applies the install on the new boot.
    await page.goto(`${scaffold.baseUrl}?restart=${Date.now()}`, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.waitForTimeout(2500)
    dialog = await openPluginsSection()
    await dialog.getByRole('tab', { name: '管理', exact: true }).click()
    await dialog.getByText('@acme/agent-search').waitFor({ timeout: 10_000 })
    await dialog.getByText('1.2.3').waitFor()

    // Remove with confirmation, then a second restart empties the list.
    await dialog.getByRole('button', { name: '删除', exact: true }).first().click()
    await dialog.getByRole('dialog', { name: '删除插件？' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '删除', exact: true }).last().click()
    await dialog.getByRole('dialog', { name: '重启后生效' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '重启', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '重启后生效' }).count(), { timeout: 10_000 }).toBe(0)

    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 10_000 }).toBe(0)
    await page.goto(`${scaffold.baseUrl}?restart=${Date.now()}`, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.waitForTimeout(2500)
    dialog = await openPluginsSection()
    await dialog.getByRole('tab', { name: '管理', exact: true }).click()
    await dialog.getByText('桌面 profile 还没有安装插件。').waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})

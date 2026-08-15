// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiscoverTab, type DiscoverTabProps } from '../src/client/DiscoverTab.tsx'
import { ManageTab, type ManageTabProps } from '../src/client/ManageTab.tsx'
import { en, type PluginCenterLocaleKey } from '../src/client/locales.ts'
import type {
  DshStudioApi, PluginCandidate, PluginInstalledInfo, PluginOperation, PluginSearchPage,
} from '../src/client/wire.ts'

afterEach(cleanup)

/** The locale translate face, with the same {{name}} interpolation the runtime performs. */
const t = ((key: PluginCenterLocaleKey, params?: Record<string, unknown>): string => {
  let text = en[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{{${name}}}`, String(value))
  }
  return text
}) as DiscoverTabProps['t']

const HIT = {
  repo: { owner: 'acme', name: 'agent-search' },
  description: 'Agent search plugin',
  stars: 42,
  updatedAt: '2026-01-01T00:00:00Z',
  url: 'https://github.com/acme/agent-search',
}

const PAGE: PluginSearchPage = {
  hits: [HIT],
  rateLimit: { remaining: 49, resetAt: '2026-01-02T00:00:00.000Z' },
}

const CANDIDATE: PluginCandidate = {
  repo: HIT.repo,
  commitSha: 'a'.repeat(40),
  packageName: '@acme/agent-search',
  license: 'MIT',
  npmVersion: '1.2.3',
  publishedAt: '2026-01-01T00:00:00.000Z',
  scriptNeeds: { scripts: ['postinstall'], nativeBuild: false },
  installable: true,
  sourceUrl: 'https://github.com/acme/agent-search',
}

function queuedOp(overrides: Partial<PluginOperation> = {}): PluginOperation {
  return {
    id: 'op-1',
    kind: 'install',
    packageName: '@acme/agent-search',
    target: '1.2.3',
    status: 'queued',
    timestamp: 1,
    ...overrides,
  }
}

function bridge(overrides: Partial<DshStudioApi> = {}): DshStudioApi {
  return {
    getInfo: vi.fn(async () => ({
      appVersion: '0.1.0', harnessVersion: '0.1.0', platform: 'darwin', arch: 'arm64',
      profile: 'desktop', logDir: '/tmp', state: 'ready',
    })),
    restartHarness: vi.fn(async () => ({ state: 'restarting', restartCount: 1, timestamp: 2 })),
    openLogs: vi.fn(async () => {}),
    exportDiagnostics: vi.fn(async () => ({ canceled: true })),
    searchPlugins: vi.fn(async () => PAGE),
    inspectPlugin: vi.fn(async () => CANDIDATE),
    installPlugin: vi.fn(async () => queuedOp()),
    removePlugin: vi.fn(async () => queuedOp({ kind: 'remove' })),
    listInstalledPlugins: vi.fn(async () => []),
    listPluginOperations: vi.fn(async () => []),
    onRuntimeStatus: vi.fn(() => () => {}),
    onPluginOperation: vi.fn(() => () => {}),
    ...overrides,
  }
}

describe('DiscoverTab', () => {
  it('renders the desktop-only notice without the bridge', () => {
    render(<DiscoverTab {...({ t, api: () => undefined } as DiscoverTabProps)} />)
    expect(screen.getByText(en.desktopOnly)).toBeTruthy()
  })

  it('searches, paginates, and shows rate-limit and no-result states', async () => {
    const search = vi.fn(async () => PAGE)
    const emptySearch = vi.fn(async () => ({ hits: [], rateLimit: { remaining: 1, resetAt: '2026-01-02T00:00:00.000Z' } }))
    const api = bridge({ searchPlugins: search })
    render(<DiscoverTab {...({ t, api: () => api } as DiscoverTabProps)} />)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()

    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'agent' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('acme/agent-search')).toBeTruthy()
    expect(search).toHaveBeenCalledWith({ query: 'agent', page: 1 })

    // A hit with no next page hides the pager.
    expect(screen.queryByText('←')).toBeNull()
    expect(screen.queryByText('→')).toBeNull()

    cleanup()
    // Search again into an empty result with a near-exhausted quota.
    const api2 = bridge({ searchPlugins: emptySearch })
    render(<DiscoverTab {...({ t, api: () => api2 } as DiscoverTabProps)} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText(en.noResults)).toBeTruthy()
    expect(screen.getByText(t('rateLimit', { remaining: 1, resetAt: '2026-01-02T00:00:00.000Z' }))).toBeTruthy()
  })

  it('inspects a candidate and refuses install scripts without confirmation', async () => {
    const inspect = vi.fn(async () => CANDIDATE)
    const install = vi.fn(async () => queuedOp())
    const api = bridge({ inspectPlugin: inspect, installPlugin: install })
    render(<DiscoverTab {...({ t, api: () => api } as DiscoverTabProps)} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent' } })
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: /acme\/agent-search/ }))
    expect(await screen.findByText('@acme/agent-search')).toBeTruthy()
    expect(inspect).toHaveBeenCalledWith({ owner: 'acme', name: 'agent-search' })
    expect(screen.getByText(en.scriptsNeeded.replace('{{scripts}}', 'postinstall'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.install }))
    // The script confirmation dialog gates the install.
    expect(screen.getByRole('dialog', { name: en.confirmTitle })).toBeTruthy()
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.confirmCancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(install).not.toHaveBeenCalled()
  })

  it('installs without scripts when the candidate declares none', async () => {
    const plain: PluginCandidate = { ...CANDIDATE, scriptNeeds: { scripts: [], nativeBuild: false } }
    const install = vi.fn(async () => queuedOp({ status: 'succeeded' }))
    const api = bridge({ inspectPlugin: vi.fn(async () => plain), installPlugin: install })
    render(<DiscoverTab {...({ t, api: () => api } as DiscoverTabProps)} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent' } })
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: /acme\/agent-search/ }))
    expect(await screen.findByText(en.scriptsSafe)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ packageName: '@acme/agent-search', version: '1.2.3', allowScripts: false })
    })
    expect(await screen.findByText(en.operationSucceeded)).toBeTruthy()
  })

  it('allows scripts after confirmation and prompts for a restart on restart-required', async () => {
    const install = vi.fn(async () => queuedOp({ status: 'restart-required' }))
    const restartHarness = vi.fn(async () => ({ state: 'restarting', restartCount: 1, timestamp: 2 }))
    const onOperation: DshStudioApi['onPluginOperation'] = (listener) => {
      listener(queuedOp({ status: 'restart-required' }))
      return () => {}
    }
    const api = bridge({ installPlugin: install, onPluginOperation: onOperation, restartHarness })
    render(<DiscoverTab {...({ t, api: () => api } as DiscoverTabProps)} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent' } })
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: /acme\/agent-search/ }))
    expect(await screen.findByText('@acme/agent-search')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmAllow }))
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ packageName: '@acme/agent-search', version: '1.2.3', allowScripts: true })
    })
    expect(await screen.findByRole('dialog', { name: en.restartTitle })).toBeTruthy()
    expect(restartHarness).toHaveBeenCalledTimes(0)
    fireEvent.click(screen.getByRole('button', { name: en.restart }))
    await waitFor(() => { expect(restartHarness).toHaveBeenCalledOnce() })
  })

  it('shows a failed install with its diagnostic code', async () => {
    const install = vi.fn(async () => queuedOp({ status: 'failed', code: 'launcher-failed' }))
    const api = bridge({ installPlugin: install })
    render(<DiscoverTab {...({ t, api: () => api } as DiscoverTabProps)} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent' } })
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: /acme\/agent-search/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.install }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmAllow }))
    await waitFor(() => { expect(install).toHaveBeenCalled() })
    expect(await screen.findByText(`${en.operationFailed} · ${en.failureCode}: launcher-failed`)).toBeTruthy()
  })

  it('shows a non-installable candidate with its rejection reason', async () => {
    const rejected: PluginCandidate = {
      ...CANDIDATE,
      installable: false,
      rejection: 'archived',
      rejectionReason: 'The repository is archived.',
    }
    const api = bridge({ inspectPlugin: vi.fn(async () => rejected) })
    render(<DiscoverTab {...({ t, api: () => api } as DiscoverTabProps)} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent' } })
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.click(await screen.findByRole('button', { name: /acme\/agent-search/ }))
    expect(await screen.findByText(`${en.notInstallable}: ${en.rejection} — The repository is archived.`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.install })).toBeNull()
  })
})

describe('ManageTab', () => {
  it('renders the desktop-only notice without the bridge', () => {
    render(<ManageTab {...({ t, api: () => undefined } as ManageTabProps)} />)
    expect(screen.getByText(en.desktopOnly)).toBeTruthy()
  })

  it('lists installed plugins and removes one after confirmation', async () => {
    const installed: PluginInstalledInfo[] = [
      { packageName: '@acme/agent-search', version: '1.2.3', bundle: true },
      { packageName: '@acme/plain', version: '0.1.0', bundle: false },
    ]
    const remove = vi.fn(async () => queuedOp({ kind: 'remove', packageName: '@acme/agent-search', status: 'restart-required' }))
    const api = bridge({ listInstalledPlugins: vi.fn(async () => installed), removePlugin: remove })
    render(<ManageTab {...({ t, api: () => api } as ManageTabProps)} />)
    expect(await screen.findByText('@acme/agent-search')).toBeTruthy()
    expect(screen.getByText(en.installedBundle)).toBeTruthy()
    expect(screen.getByText(en.installedPlain)).toBeTruthy()

    const removeButtons = screen.getAllByRole('button', { name: en.remove })
    fireEvent.click(removeButtons[0]!)
    const dialog = screen.getByRole('dialog', { name: en.removeConfirmTitle })
    expect(dialog).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.remove }))
    await waitFor(() => { expect(remove).toHaveBeenCalledWith({ packageName: '@acme/agent-search' }) })
    expect(await screen.findByRole('dialog', { name: en.restartTitle })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.restartLater }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retries a failed install: scripts-not-confirmed asks again, others resubmit directly', async () => {
    const failed: PluginOperation = {
      id: 'op-fail', kind: 'install', packageName: '@acme/agent-search', target: '1.2.3',
      status: 'failed', timestamp: 1, code: 'scripts-not-confirmed',
    }
    const install = vi.fn(async () => queuedOp({ id: 'op-retry', status: 'queued' }))
    const api = bridge({
      listPluginOperations: vi.fn(async () => [failed]),
      installPlugin: install,
    })
    render(<ManageTab {...({ t, api: () => api } as ManageTabProps)} />)
    expect(await screen.findByText('@acme/agent-search')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    // The confirmation gate reappears for a script-needing retry.
    expect(screen.getByRole('dialog', { name: en.confirmTitle })).toBeTruthy()
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.confirmAllow }))
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ packageName: '@acme/agent-search', version: '1.2.3', allowScripts: true })
    })
    expect(await screen.findByText(en.resumed)).toBeTruthy()
  })

  it('retries a launcher-failed operation without a dialog', async () => {
    const failed: PluginOperation = {
      id: 'op-fail', kind: 'install', packageName: '@acme/plain', target: '0.1.0',
      status: 'failed', timestamp: 1, code: 'launcher-failed',
    }
    const install = vi.fn(async () => queuedOp({ id: 'op-retry', packageName: '@acme/plain', target: '0.1.0', status: 'queued' }))
    const api = bridge({
      listPluginOperations: vi.fn(async () => [failed]),
      installPlugin: install,
    })
    render(<ManageTab {...({ t, api: () => api } as ManageTabProps)} />)
    expect(await screen.findByText('@acme/plain')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ packageName: '@acme/plain', version: '0.1.0', allowScripts: false })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the empty states for installed plugins and operations', async () => {
    const api = bridge({
      listInstalledPlugins: vi.fn(async () => []),
      listPluginOperations: vi.fn(async () => []),
    })
    render(<ManageTab {...({ t, api: () => api } as ManageTabProps)} />)
    expect(await screen.findByText(en.installedEmpty)).toBeTruthy()
    expect(screen.getByText(en.operationsEmpty)).toBeTruthy()
  })
})

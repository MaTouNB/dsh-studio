// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { DiscoverTab } from '../src/client/DiscoverTab.tsx'
import { ManageTab } from '../src/client/ManageTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-center browser plugin', () => {
  it('declares only the services used by the Settings contribution', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the localized Discover and Manage tabs in order', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const tabs = b.slots.entries('settings.plugins.tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.component).toBe(DiscoverTab)
    expect(tabs[0]!.options).toMatchObject({ id: 'discover', order: 5 })
    expect(tabs[0]!.locale).toBe(NS)
    expect(resolveSlotLabel(tabs[0]!.options.label)).toBe('发现')
    expect(tabs[1]!.component).toBe(ManageTab)
    expect(tabs[1]!.options).toMatchObject({ id: 'manage', order: 6 })
    expect(resolveSlotLabel(tabs[1]!.options.label)).toBe('管理')
    await b.ctx.fiber.dispose()
  })

  it('injects the window-bridge accessor without touching window eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const discover = b.slots.entries('settings.plugins.tab')[0]!
    const injected = (discover.inject as unknown as () => { api: () => unknown })()
    // The accessor reads window lazily: undefined in jsdom without a stub.
    expect(injected.api()).toBeUndefined()
    const stub = { searchPlugins: vi.fn() }
    ;(window as unknown as { dshStudio?: unknown }).dshStudio = stub
    expect(injected.api()).toBe(stub)
    delete (window as unknown as { dshStudio?: unknown }).dshStudio
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(2) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Discover')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[1]!.options.label)).toBe('Manage')
    stop()
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0) })
    await b.ctx.fiber.dispose()
  })
})

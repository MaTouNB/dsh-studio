/**
 * Desktop plugin-center Settings contribution, browser half: two
 * `settings.plugins.tab` entries (Discover / Manage) that drive the DSH
 * Studio window bridge (`window.dshStudio`). The desktop profile mounts this
 * package through the desktop-integration bundle's patch, so the tabs only
 * ever appear there; on any other deployment the bridge is absent and each
 * tab renders a desktop-only notice.
 *
 * Collaboration with the settings shell is type-only (the section lives in
 * ui-settings-plugins and the shell in ui-settings); the only runtime
 * services used are slots and locale.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginCenterLocaleKey } from './locales.ts'
import { en, zh } from './locales.ts'
import { DiscoverTab, type DiscoverTabInjected } from './DiscoverTab.tsx'
import { ManageTab, type ManageTabInjected } from './ManageTab.tsx'
import { dshStudio } from './window-api.ts'

export type { DiscoverTabInjected, DiscoverTabProps } from './DiscoverTab.tsx'
export type { ManageTabInjected, ManageTabProps } from './ManageTab.tsx'
export type { PluginCenterLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop plugin-center tabs copy. */
    'settings.pluginCenter': PluginCenterLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginCenter'

/** Services required by the Settings contribution. */
export const inject = ['slots', 'locale']

/** The injected face both tabs share: the desktop bridge accessor. */
const injected = (): DiscoverTabInjected & ManageTabInjected => ({ api: dshStudio })

/** Contribute the Discover and Manage tabs to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-center: dictionaries')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'discover',
    order: 5,
    label: () => t('discoverTab'),
    locale: NS,
    inject: injected,
  }, DiscoverTab))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manage',
    order: 6,
    label: () => t('manageTab'),
    locale: NS,
    inject: injected,
  }, ManageTab))
}

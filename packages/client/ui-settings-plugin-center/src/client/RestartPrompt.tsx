/**
 * Restart confirmation shared by the plugin-center tabs: a plugin change
 * reaches the profile only after the Harness restarts, so the UI asks first
 * and calls the bridge's restart when confirmed.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-center/client/RestartPrompt
 */

import { useState } from 'react'
import type { PluginCenterLocaleKey } from './locales.ts'
import type { DshStudioApi } from './wire.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'

/** Restart-prompt props. */
export interface RestartPromptProps {
  t: (key: PluginCenterLocaleKey, params?: Record<string, unknown>) => string
  bridge: DshStudioApi
  /** Called after the restart request settles (the page usually reloads). */
  onDone: () => void
}

/** Ask before restarting the Harness to apply a plugin change. */
export function RestartPrompt({ t, bridge, onDone }: RestartPromptProps) {
  const [restarting, setRestarting] = useState(false)
  return (
    <ConfirmDialog
      title={t('restartTitle')}
      body={t('restartBody')}
      confirmLabel={restarting ? t('restarting') : t('restart')}
      cancelLabel={t('restartLater')}
      busy={restarting}
      onConfirm={() => {
        setRestarting(true)
        void bridge.restartHarness().then(onDone).catch(onDone)
      }}
      onCancel={onDone}
    />
  )
}

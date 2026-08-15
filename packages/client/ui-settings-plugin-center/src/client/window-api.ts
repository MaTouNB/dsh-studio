/**
 * The DSH Studio window bridge accessor. The Electron preload exposes a
 * frozen `window.dshStudio` in the main frame; this package's tabs are only
 * mounted by the desktop profile, so the bridge is present there, and absent
 * on a plain Harness web deployment (where the tabs degrade to a notice).
 * Tests stub the bridge on `window` directly.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-center/client/window-api
 */

import type { DshStudioApi } from './wire.ts'

/** The global carrying the preload bridge. */
interface DshStudioWindow extends Window {
  dshStudio?: DshStudioApi
}

/**
 * The desktop bridge, or `undefined` when the page is not hosted by the
 * DSH Studio shell (plain `dsh web`, or a test without a stub).
 * @returns the frozen bridge object.
 */
export function dshStudio(): DshStudioApi | undefined {
  return (window as DshStudioWindow).dshStudio
}

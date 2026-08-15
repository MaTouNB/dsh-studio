/**
 * Manage tab: the desktop-profile-owned installed bundles, the persisted
 * operation ledger with live progress, and removal / retry of failed
 * changes. Desktop-only like Discover — without the bridge it renders a
 * notice.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-center/client/ManageTab
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DshStudioApi, PluginInstalledInfo, PluginOperation,
} from './wire.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { RestartPrompt } from './RestartPrompt.tsx'
import { OperationState } from './DiscoverTab.tsx'
import css from './plugin-center.module.css'

/** Registration-side business face for the Manage tab. */
export interface ManageTabInjected {
  /** The desktop bridge, or `undefined` on a plain web deployment. */
  readonly api: () => DshStudioApi | undefined
}

/** Props the renderer binds for the Manage tab. */
export type ManageTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginCenter'>
  & InjectFace<ManageTabInjected>

/** The removal confirmation state. */
interface RemoveConfirm {
  packageName: string
}

/** The retry confirmation state (a failed install that needs scripts). */
interface RetryConfirm {
  packageName: string
  version: string
}

/** Review installed desktop plugins, operations, and failed changes. */
export function ManageTab({ t, api }: ManageTabProps) {
  const bridge = api()
  const [installed, setInstalled] = useState<PluginInstalledInfo[] | undefined>()
  const [operations, setOperations] = useState<PluginOperation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [removeConfirm, setRemoveConfirm] = useState<RemoveConfirm | undefined>()
  const [retryConfirm, setRetryConfirm] = useState<RetryConfirm | undefined>()
  const [restartPrompt, setRestartPrompt] = useState(false)
  const [resumed, setResumed] = useState<string | undefined>()

  useEffect(() => {
    if (bridge === undefined) return
    const refresh = async (): Promise<void> => {
      setLoading(true)
      try {
        setInstalled(await bridge.listInstalledPlugins())
        setOperations(await bridge.listPluginOperations())
        setError(undefined)
      } catch (cause) {
        setError(t('unknownError'))
        void cause
      } finally {
        setLoading(false)
      }
    }
    void refresh()
    return bridge.onPluginOperation((next) => {
      setOperations(previous => [next, ...previous.filter(op => op.id !== next.id)])
      if (next.status === 'restart-required') setRestartPrompt(true)
    })
  }, [bridge, t])

  if (bridge === undefined) {
    return <p className={css.notice}>{t('desktopOnly')}</p>
  }

  const confirmRemove = (packageName: string): void => {
    setRemoveConfirm({ packageName })
  }

  const runRemove = async (packageName: string): Promise<void> => {
    setRemoveConfirm(undefined)
    setBusy(packageName)
    setError(undefined)
    try {
      const op = await bridge.removePlugin({ packageName })
      setOperations(previous => [op, ...previous.filter(candidate => candidate.id !== op.id)])
      if (op.status === 'restart-required') setRestartPrompt(true)
    } catch (cause) {
      setError(t('unknownError'))
      void cause
    } finally {
      setBusy(undefined)
    }
  }

  const retryOperation = (operation: PluginOperation): void => {
    if (operation.code === 'scripts-not-confirmed') {
      setRetryConfirm({ packageName: operation.packageName, version: operation.target })
      return
    }
    void resubmit(operation, false)
  }

  const resubmit = async (operation: PluginOperation, allowScripts: boolean): Promise<void> => {
    setRetryConfirm(undefined)
    setBusy(operation.id)
    setError(undefined)
    setResumed(undefined)
    try {
      const request = operation.kind === 'install'
        ? bridge.installPlugin({ packageName: operation.packageName, version: operation.target, allowScripts })
        : bridge.removePlugin({ packageName: operation.packageName })
      const op = await request
      setOperations(previous => [op, ...previous.filter(candidate => candidate.id !== op.id)])
      setResumed(op.id)
      if (op.status === 'restart-required') setRestartPrompt(true)
    } catch (cause) {
      setError(t('unknownError'))
      void cause
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className={css.tab}>
      <p className={css.status}>{t('manageIntro')}</p>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <section aria-label={t('accessibleInstalled')}>
        <h3>{t('installed')}</h3>
        {loading && installed === undefined && <p className={css.status}>{t('loading')}</p>}
        {installed !== undefined && installed.length === 0 && <p className={css.status}>{t('installedEmpty')}</p>}
        {installed !== undefined && installed.length > 0 && (
          <ul className={css.installedList}>
            {installed.map(entry => (
              <li key={entry.packageName} className={css.installedRow}>
                <span className={css.installedInfo}>
                  <span className={css.installedName}>{entry.packageName}</span>
                  <span className={css.factRow}>
                    {entry.version}
                    <span className={css.tag}>{entry.bundle ? t('installedBundle') : t('installedPlain')}</span>
                  </span>
                </span>
                <button
                  className={css.button}
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => { confirmRemove(entry.packageName) }}
                >
                  {busy === entry.packageName ? t('removing') : t('remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label={t('accessibleOperations')}>
        <h3>{t('operations')}</h3>
        {operations.length === 0 && <p className={css.status}>{t('operationsEmpty')}</p>}
        {operations.length > 0 && (
          <table className={css.operationsTable}>
            <thead>
              <tr>
                <th>{t('operations')}</th>
                <th>id</th>
                <th>{t('operationInstall')}/{t('operationRemove')}</th>
                <th>target</th>
                <th>{t('operations')}</th>
                <th>{t('failureCode')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {operations.map(operation => (
                <tr key={operation.id}>
                  <td>{operation.kind === 'install' ? t('operationInstall') : t('operationRemove')}</td>
                  <td>{operation.packageName}</td>
                  <td>{operation.target}</td>
                  <td><OperationState t={t} operation={operation} /></td>
                  <td>{operation.code ?? ''}</td>
                  <td>
                    {operation.status === 'failed' && (
                      <button
                        className={css.button}
                        type="button"
                        disabled={busy !== undefined}
                        onClick={() => { retryOperation(operation) }}
                      >
                        {t('retry')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {resumed !== undefined && <p className={css.status} role="status">{t('resumed')}</p>}
      </section>
      {removeConfirm !== undefined && (
        <ConfirmDialog
          title={t('removeConfirmTitle')}
          body={t('removeConfirmBody', { package: removeConfirm.packageName })}
          confirmLabel={t('remove')}
          cancelLabel={t('confirmCancel')}
          busy={busy === removeConfirm.packageName}
          onConfirm={() => { void runRemove(removeConfirm.packageName) }}
          onCancel={() => { setRemoveConfirm(undefined) }}
        />
      )}
      {retryConfirm !== undefined && (
        <ConfirmDialog
          title={t('confirmTitle')}
          body={t('confirmBody', { package: retryConfirm.packageName, version: retryConfirm.version, extra: '' })}
          confirmLabel={t('confirmAllow')}
          cancelLabel={t('confirmCancel')}
          busy={busy !== undefined}
          onConfirm={() => {
            const op = operations.find(candidate => candidate.packageName === retryConfirm.packageName && candidate.kind === 'install')
            if (op !== undefined) void resubmit(op, true)
          }}
          onCancel={() => { setRetryConfirm(undefined) }}
        />
      )}
      {restartPrompt && (
        <RestartPrompt
          t={t}
          bridge={bridge}
          onDone={() => { setRestartPrompt(false) }}
        />
      )}
    </div>
  )
}

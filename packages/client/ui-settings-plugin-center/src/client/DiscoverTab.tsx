/**
 * Discover tab: search the dsh-plugin topic, inspect a candidate repository,
 * confirm install scripts when the exact version requests them, and drive
 * one exact-version install. The tab is desktop-only: without the
 * `window.dshStudio` bridge it renders a notice instead of failing.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-center/client/DiscoverTab
 */

import { useEffect, useState, type FormEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginCenterLocaleKey } from './locales.ts'
import type {
  DshStudioApi, PluginCandidate, PluginOperation, PluginSearchHit, PluginSearchPage,
} from './wire.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { RestartPrompt } from './RestartPrompt.tsx'
import css from './plugin-center.module.css'

/** Registration-side business face for the Discover tab. */
export interface DiscoverTabInjected {
  /** The desktop bridge, or `undefined` on a plain web deployment. */
  readonly api: () => DshStudioApi | undefined
}

/** Props the renderer binds for the Discover tab. */
export type DiscoverTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginCenter'>
  & InjectFace<DiscoverTabInjected>

/** The install-script confirmation state. */
interface ScriptConfirm {
  packageName: string
  version: string
  scripts: readonly string[]
  nativeBuild: boolean
}

/** Search and install one exact-version desktop plugin. */
export function DiscoverTab({ t, api }: DiscoverTabProps) {
  const bridge = api()
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<PluginSearchPage | undefined>()
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [candidate, setCandidate] = useState<PluginCandidate | undefined>()
  const [inspecting, setInspecting] = useState(false)
  const [operation, setOperation] = useState<PluginOperation | undefined>()
  const [installing, setInstalling] = useState(false)
  const [confirm, setConfirm] = useState<ScriptConfirm | undefined>()
  const [restartPrompt, setRestartPrompt] = useState(false)

  useEffect(() => {
    if (bridge === undefined) return
    return bridge.onPluginOperation((next) => {
      setOperation(next)
      if (next.status === 'restart-required') setRestartPrompt(true)
    })
  }, [bridge])

  if (bridge === undefined) {
    return <p className={css.notice}>{t('desktopOnly')}</p>
  }

  const runSearch = async (target: string, targetPage: number): Promise<void> => {
    setSearching(true)
    setError(undefined)
    try {
      const next = await bridge.searchPlugins({ query: target, page: targetPage })
      setResult(next)
      setPage(targetPage)
    } catch (cause) {
      setError(t('unknownError'))
      void cause
    } finally {
      setSearching(false)
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const target = query.trim()
    if (target === '') return
    setSubmitted(target)
    setCandidate(undefined)
    void runSearch(target, 1)
  }

  const openPage = (targetPage: number): void => {
    if (submitted === '' || searching) return
    void runSearch(submitted, targetPage)
  }

  const inspect = async (hit: PluginSearchHit): Promise<void> => {
    setInspecting(true)
    setError(undefined)
    try {
      setCandidate(await bridge.inspectPlugin({ owner: hit.repo.owner, name: hit.repo.name }))
    } catch (cause) {
      setError(t('unknownError'))
      void cause
    } finally {
      setInspecting(false)
    }
  }

  const install = async (allowScripts: boolean): Promise<void> => {
    if (candidate?.packageName === undefined || candidate.npmVersion === undefined) return
    setConfirm(undefined)
    setInstalling(true)
    setError(undefined)
    try {
      const op = await bridge.installPlugin({
        packageName: candidate.packageName,
        version: candidate.npmVersion,
        allowScripts,
      })
      setOperation(op)
      if (op.status === 'restart-required') setRestartPrompt(true)
    } catch (cause) {
      setError(t('unknownError'))
      void cause
    } finally {
      setInstalling(false)
    }
  }

  const startInstall = (): void => {
    if (candidate?.packageName === undefined || candidate.npmVersion === undefined) return
    const needs = candidate.scriptNeeds
    const needsScripts = needs !== undefined && (needs.scripts.length > 0 || needs.nativeBuild)
    if (needsScripts) {
      setConfirm({
        packageName: candidate.packageName,
        version: candidate.npmVersion,
        scripts: needs.scripts,
        nativeBuild: needs.nativeBuild,
      })
      return
    }
    void install(false)
  }

  const scriptsExtra = (): string => {
    if (confirm === undefined) return ''
    const parts: string[] = []
    if (confirm.scripts.length > 0) parts.push(` (${confirm.scripts.join(', ')})`)
    if (confirm.nativeBuild) parts.push(` ${t('nativeBuild')}`)
    return parts.join('')
  }

  const rateLimit = result?.rateLimit

  return (
    <div className={css.tab}>
      <p className={css.status}>{t('discoverIntro')}</p>
      <form className={css.searchRow} onSubmit={submit} role="search" aria-label={t('accessibleSearch')}>
        <input
          className={css.searchInput}
          type="search"
          value={query}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <button className={`${css.button} ${css.buttonPrimary}`} type="submit" disabled={searching}>
          {searching ? t('searching') : t('searchButton')}
        </button>
      </form>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {rateLimit !== undefined && rateLimit.remaining <= 5 && (
        <p className={css.rateLimit} role="status">
          {t('rateLimit', { remaining: rateLimit.remaining, resetAt: rateLimit.resetAt })}
        </p>
      )}
      {submitted === '' && result === undefined && !searching && (
        <p className={css.status}>{t('emptySearch')}</p>
      )}
      {result !== undefined && result.hits.length === 0 && <p className={css.status}>{t('noResults')}</p>}
      {result !== undefined && result.hits.length > 0 && (
        <ul className={css.hits} aria-label={t('accessibleCandidates')}>
          {result.hits.map(hit => (
            <li key={`${hit.repo.owner}/${hit.repo.name}`} className={css.hit}>
              <button className={css.hitButton} type="button" onClick={() => { void inspect(hit) }}>
                <span className={css.hitTitle}>
                  <span>{hit.repo.owner}/{hit.repo.name}</span>
                  <span className={css.hitMeta}>{t('installable')}</span>
                </span>
                {hit.description !== undefined && <span className={css.hitMeta}>{hit.description}</span>}
                <span className={css.hitMeta}>
                  ★ {hit.stars} · {hit.updatedAt.slice(0, 10)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(result?.nextPage !== undefined || page > 1) && (
        <div className={css.pagination}>
          <button className={css.button} type="button" disabled={page <= 1 || searching} onClick={() => { openPage(page - 1) }}>
            ←
          </button>
          <span className={css.status}>{page}</span>
          <button className={css.button} type="button" disabled={result?.nextPage === undefined || searching} onClick={() => { openPage(result?.nextPage ?? page) }}>
            →
          </button>
        </div>
      )}
      {inspecting && <p className={css.status}>{t('inspecting')}</p>}
      {candidate !== undefined && (
        <section className={css.candidate} aria-label={candidate.packageName ?? `${candidate.repo.owner}/${candidate.repo.name}`}>
          <div className={css.candidateTitle}>{candidate.packageName ?? `${candidate.repo.owner}/${candidate.repo.name}`}</div>
          <div className={css.factRow}>
            <span>{t('npmVersion')}: {candidate.npmVersion ?? '—'}</span>
            {candidate.license !== undefined && <span>{t('license')}: {candidate.license}</span>}
            <span>{t('publishedAt')}: {candidate.publishedAt !== undefined ? candidate.publishedAt.slice(0, 10) : '—'}</span>
            <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">{t('openSource')}</a>
          </div>
          {candidate.scriptNeeds !== undefined && (
            <div className={css.factRow}>
              {candidate.scriptNeeds.scripts.length > 0 || candidate.scriptNeeds.nativeBuild
                ? (
                  <span className={css.error}>
                    {t('scriptsNeeded', { scripts: candidate.scriptNeeds.scripts.join(', ') || t('nativeBuild') })}
                  </span>
                )
                : <span>{t('scriptsSafe')}</span>}
            </div>
          )}
          {candidate.installable ? (
            <div className={css.actions}>
              <button
                className={`${css.button} ${css.buttonPrimary}`}
                type="button"
                disabled={installing || candidate.npmVersion === undefined}
                onClick={startInstall}
              >
                {installing ? t('installing') : t('install')}
              </button>
              {operation !== undefined && <OperationState t={t} operation={operation} />}
            </div>
          ) : (
            <div className={css.error}>
              <span>{t('notInstallable')}: {t('rejection')} — {candidate.rejectionReason ?? candidate.rejection ?? ''}</span>
            </div>
          )}
        </section>
      )}
      {confirm !== undefined && (
        <ConfirmDialog
          title={t('confirmTitle')}
          body={(
            <>
              <span>{t('confirmBody', { package: confirm.packageName, version: confirm.version, extra: scriptsExtra() })}</span>
              {confirm.scripts.length > 0 && (
                <ul className={css.scriptList}>
                  {confirm.scripts.map(script => <li key={script}>{script}</li>)}
                </ul>
              )}
            </>
          )}
          confirmLabel={t('confirmAllow')}
          cancelLabel={t('confirmCancel')}
          busy={installing}
          onConfirm={() => { void install(true) }}
          onCancel={() => { setConfirm(undefined) }}
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

/** Localized operation status chip. */
export function OperationState({
  t,
  operation,
}: {
  t: (key: PluginCenterLocaleKey, params?: Record<string, unknown>) => string
  operation: PluginOperation
}) {
  const label = {
    queued: t('operationQueued'),
    running: t('operationRunning'),
    'restart-required': t('operationRestartRequired'),
    succeeded: t('operationSucceeded'),
    failed: t('operationFailed'),
  }[operation.status]
  return (
    <span className={operation.status === 'failed' ? css.error : css.status} role="status">
      {label}{operation.code !== undefined ? ` · ${t('failureCode')}: ${operation.code}` : ''}
    </span>
  )
}

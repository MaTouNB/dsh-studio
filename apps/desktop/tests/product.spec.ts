import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  APP_ID,
  DISCLAIMER,
  PRODUCT_NAME,
  PRODUCT_SUBTITLE,
  releaseTag,
} from '../src/product.ts'

/** The workspace root this package's files live under. */
const appDir = fileURLToPath(new URL('..', import.meta.url))

/** `apps/desktop/package.json`, the single version source. */
const manifest = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8')) as {
  name: string
  description: string
  version: string
  private: boolean
  type: string
  license: string
}

/** The Electron Builder skeleton, parsed from the YAML placeholder. */
const builderConfig = yaml.load(readFileSync(resolve(appDir, 'electron-builder.yml'), 'utf8')) as {
  appId?: unknown
  productName?: unknown
  artifactName?: unknown
}

/** The English README, home of the machine-checked unofficial declaration. */
const readme = readFileSync(resolve(appDir, 'README.md'), 'utf8')

/** Exact semver with an optional prerelease suffix; never a range. */
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

describe('DSH Studio product metadata', () => {
  it('keeps the workspace package private and unpublishable', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-desktop')
    expect(manifest.private).toBe(true)
    expect(manifest.type).toBe('module')
    expect(manifest.license).toBe('MIT')
  })

  it('owns an exact prerelease version', () => {
    expect(manifest.version).toMatch(exactSemver)
  })

  it('derives the desktop-v* release tag from the package version', () => {
    expect(releaseTag(manifest.version)).toBe(`desktop-v${manifest.version}`)
    expect(releaseTag(manifest.version)).toMatch(
      /^desktop-v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    )
  })

  it('agrees with the Electron Builder skeleton on the application id and product name', () => {
    expect(builderConfig.appId).toBe(APP_ID)
    expect(builderConfig.productName).toBe(PRODUCT_NAME)
  })

  it('names artifacts from the product, version, OS, and architecture', () => {
    expect(builderConfig.artifactName).toContain('${productName}')
    expect(builderConfig.artifactName).toContain('${version}')
    expect(builderConfig.artifactName).toContain('${os}')
    expect(builderConfig.artifactName).toContain('${arch}')
  })

  it('carries the unofficial declaration in the manifest and README', () => {
    expect(manifest.description).toContain(PRODUCT_SUBTITLE)
    expect(readme).toContain(PRODUCT_SUBTITLE)
    expect(readme).toContain(DISCLAIMER)
  })
})

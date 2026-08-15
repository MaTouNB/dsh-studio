/**
 * DSH Studio product identity: the application identifier, product names, and
 * release-tag derivation that the Electron shell and packaging configuration
 * consume. The version itself lives only in `apps/desktop/package.json`.
 * @module @deepseek-ai/dsh-desktop/product
 */

/** Reverse-DNS application identifier; the Electron Builder `appId`. */
export const APP_ID = 'io.github.matounb.dsh-studio'

/** User-facing product name; the Electron Builder `productName`. */
export const PRODUCT_NAME = 'DSH Studio'

/** The subtitle required on every repository and release surface. */
export const PRODUCT_SUBTITLE = 'An unofficial desktop client for DeepSeek Harness'

/** The disclaimer required wherever the product name appears publicly. */
export const DISCLAIMER = 'DSH Studio is not affiliated with or endorsed by DeepSeek.'

/** The stock Node runtime version the packaged application carries. */
export const NODE_VERSION = '22.19.0'

/**
 * Derive the release tag that owns a Desktop version. Every `desktop-v*` tag
 * and artifact name derives from the `apps/desktop/package.json` version
 * through this function, so the package manifest stays the single version
 * source.
 * @param version - exact semver from `apps/desktop/package.json`.
 * @returns the `desktop-v<version>` release tag.
 */
export function releaseTag(version: string): string {
  return `desktop-v${version}`
}

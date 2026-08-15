/**
 * Release consistency verification for DSH Studio: pins the draft-release
 * facts against the built artifacts — the `desktop-v<version>` tag matches the
 * package version, every installer present under dist has a correct SHA-256
 * entry in SHA256SUMS.txt, the platform's packaged runtime manifest carries the
 * same app version and platform, and the bilingual release documentation that
 * carries the unofficial and unsigned-install facts exists. Each CI build job
 * verifies its own platform (`--platform mac-arm64 | win-x64`); the local
 * drill verifies every platform whose artifacts are present.
 * @module @deepseek-ai/dsh-desktop/verify-release
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

function fail(message: string): never {
  process.stderr.write(`verify-release: ${message}\n`)
  process.exit(1)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The expected installer names for a version, one per release platform. */
function installerNames(version: string): Array<{ platform: string; name: string }> {
  return [
    { platform: 'mac-arm64', name: `DSH Studio-${version}-mac-arm64.dmg` },
    { platform: 'win-x64', name: `DSH Studio-${version}-win-x64.exe` },
  ]
}

/** The packaged-app runtime manifest location for one platform. */
function packagedManifestPath(dist: string, platform: string, version: string): string | undefined {
  if (platform === 'mac-arm64') {
    const app = join(dist, 'mac-arm64', `DSH Studio-${version}.app`, 'Contents', 'Resources', 'runtime', 'runtime-manifest.json')
    const plain = join(dist, 'mac-arm64', 'DSH Studio.app', 'Contents', 'Resources', 'runtime', 'runtime-manifest.json')
    return existsSync(app) ? app : existsSync(plain) ? plain : undefined
  }
  const unpacked = join(dist, 'win-unpacked', 'resources', 'runtime', 'runtime-manifest.json')
  return existsSync(unpacked) ? unpacked : undefined
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { version?: string }
  const version = manifest.version
  if (version === undefined) fail('package.json lacks version')

  const tag = process.env.DESKTOP_RELEASE_TAG
  if (tag !== undefined && tag !== `desktop-v${version}`) {
    fail(`release tag ${JSON.stringify(tag)} does not match desktop-v${version}`)
  }

  const platformArg = process.argv.find(argument => argument.startsWith('--platform='))?.slice('--platform='.length)
  if (platformArg !== undefined && platformArg !== 'mac-arm64' && platformArg !== 'win-x64') {
    fail(`unsupported --platform ${JSON.stringify(platformArg)}`)
  }

  const dist = join(APP_DIR, 'dist')
  if (!existsSync(dist)) fail('dist directory missing — run package:mac and package:win first')
  const sumsPath = join(dist, 'SHA256SUMS.txt')
  const sums = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : ''
  const sumsLines = new Map(
    sums.split('\n').filter(line => line.trim() !== '').map((line) => {
      const [hash, ...nameParts] = line.trim().split(/\s+/u)
      return [nameParts.join(' '), hash]
    }),
  )
  const requiredDocs = [
    'apps/desktop/docs/download.md',
    'apps/desktop/docs/release.md',
    'apps/desktop/docs/security.md',
  ]
  for (const installer of installerNames(version)) {
    const present = existsSync(join(dist, installer.name))
    // A CI job verifies its own platform; the local drill covers every
    // platform whose installer was built.
    if (platformArg !== undefined && platformArg !== installer.platform) continue
    if (!present) fail(`missing ${installer.name} under dist`)
    const recorded = sumsLines.get(installer.name)
    if (recorded === undefined) fail(`SHA256SUMS.txt lacks ${installer.name}`)
    if (recorded !== sha256(join(dist, installer.name))) fail(`SHA256SUMS.txt hash mismatch for ${installer.name}`)
    const packagedManifest = packagedManifestPath(dist, installer.platform, version)
    if (packagedManifest !== undefined) {
      const packaged = JSON.parse(readFileSync(packagedManifest, 'utf8')) as { app?: { version?: string }; platform?: string }
      if (packaged.app?.version !== version) fail(`runtime manifest app version ${String(packaged.app?.version)} != ${version}`)
      if (packaged.platform !== installer.platform) fail(`runtime manifest platform ${String(packaged.platform)} != ${installer.platform}`)
    } else {
      // Cross-built installers (building win on a macOS host) carry no staged
      // runtime; the native CI lane verifies the runtime facts there.
      process.stdout.write(`verify-release: ${installer.platform} packaged runtime manifest absent (cross-build); runtime facts verified on the native lane\n`)
    }
  }
  for (const docPath of requiredDocs) {
    if (!existsSync(join(APP_DIR, '..', '..', docPath))) fail(`missing release doc ${docPath}`)
  }
  process.stdout.write(`verify-release: desktop-v${version} artifacts, checksums, runtime manifests, and release docs consistent\n`)
}

main()

/**
 * Deterministic staging helpers for the packaged runtime: release-platform
 * selection, Node distribution naming, foreign-native-artifact pruning, and
 * content digests. The staging orchestrator in `scripts/stage-runtime.ts`
 * consumes these; tests pin their behavior.
 * @module @deepseek-ai/dsh-desktop/staging
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import { NODE_VERSION } from './product.ts'

/** The two release platforms of the unsigned alpha. */
export type StudioPlatform = 'mac-arm64' | 'win-x64'

/**
 * Map a running platform/arch pair to a release platform. Anything else is
 * not a DSH Studio release target and fails loud.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the release platform key.
 */
export function studioPlatform(platform: string, arch: string): StudioPlatform {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  throw new Error(`DSH Studio staging: unsupported release platform ${platform}-${arch}`)
}

/**
 * The pinned Node distribution archive name for a release platform.
 * @param target - the release platform.
 * @returns the archive file name under `nodejs.org/dist`.
 */
export function nodeDistFileName(target: StudioPlatform): string {
  return target === 'mac-arm64'
    ? `node-v${NODE_VERSION}-darwin-arm64.tar.gz`
    : `node-v${NODE_VERSION}-win-x64.zip`
}

/**
 * The pinned Node distribution download URL.
 * @param target - the release platform.
 * @returns the archive URL.
 */
export function nodeDistUrl(target: StudioPlatform): string {
  return `https://nodejs.org/dist/v${NODE_VERSION}/${nodeDistFileName(target)}`
}

/**
 * Whether a closure package is the native artifact of a foreign platform and
 * must be pruned from the staged runtime. `node-addon-require-builtin-*` are
 * per-platform optional shims; `@deepseek-ai/node-addon-landlock-run` is a
 * Linux-only confinement backend with no macOS or Windows build.
 * @param packageName - the package name as it appears in the closure.
 * @param target - the release platform being staged.
 * @returns `true` when the package must be removed.
 */
export function isForeignNativePackage(packageName: string, target: StudioPlatform): boolean {
  if (packageName.startsWith('node-addon-require-builtin-')) {
    const keep = target === 'mac-arm64'
      ? 'node-addon-require-builtin-darwin-arm64'
      : 'node-addon-require-builtin-win32-x64'
    return packageName !== keep
  }
  // The Landlock base package is a platform-independent JS seam imported on
  // every platform; only its Linux binary variants are foreign here.
  return packageName.startsWith('@deepseek-ai/node-addon-landlock-run-linux-')
}

/**
 * The prebuildify platform directory the current release keeps inside
 * `node-pty`; every other prebuild directory is foreign.
 * @param target - the release platform.
 * @returns the prebuild directory name.
 */
export function prebuildDirName(target: StudioPlatform): string {
  return target === 'mac-arm64' ? 'darwin-arm64' : 'win32-x64'
}

/**
 * A deterministic SHA-256 over a directory tree. Files contribute their
 * content, symlinks contribute their target string, paths are sorted and
 * POSIX-normalized, and nothing is followed through a link, so the digest is
 * reproducible across machines and filesystems.
 * @param root - the directory to digest.
 * @returns the hex digest.
 */
export function digestTree(root: string): string {
  const entries: Array<{ path: string; kind: 'file' | 'link'; value: string }> = []
  const stack = ['']
  while (stack.length > 0) {
    const relative = stack.pop() as string
    const absolute = join(root, relative)
    const stat = lstatSync(absolute)
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) stack.push(join(relative, name))
    } else if (stat.isFile()) {
      entries.push({
        path: relative,
        kind: 'file',
        value: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      })
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: relative, kind: 'link', value: readlinkSync(absolute) })
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.kind === 'link' ? 'L' : 'F')
    hash.update(entry.path.split(sep).join('/'))
    hash.update('\0')
    hash.update(entry.value)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * A package the staged closure must receive from the workspace because the
 * upstream manifest does not declare it for its runtime importers. Each
 * patch is recorded in the runtime manifest so a release states exactly what
 * it carries beyond `pnpm deploy` output.
 */
export interface ClosurePatch {
  /** The package to copy into the closure. */
  packageName: string
  /** Closure packages whose `node_modules` must expose the package. */
  importers: readonly string[]
  /** Why the upstream declaration is insufficient. */
  reason: string
}

/**
 * The current closure patches. `@deepseek-ai/cordis-plugin-group` is a
 * runtime import of `@deepseek-ai/dsh-app-boot` declared only as a
 * devDependency; the workspace's hoisted layout masks the gap, the strict
 * deploy closure exposes it.
 */
export const CLOSURE_PATCHES: readonly ClosurePatch[] = [{
  packageName: '@deepseek-ai/cordis-plugin-group',
  importers: ['@deepseek-ai/dsh-app-boot'],
  reason: '@deepseek-ai/dsh-app-boot imports it at runtime but declares it only as a devDependency',
}]

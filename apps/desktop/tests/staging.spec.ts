import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_VERSION } from '../src/product.ts'
import {
  CLOSURE_PATCHES,
  digestTree,
  isForeignNativePackage,
  nodeDistFileName,
  nodeDistUrl,
  prebuildDirName,
  studioPlatform,
} from '../src/staging.ts'

describe('release platform selection', () => {
  it('maps the two alpha platforms', () => {
    expect(studioPlatform('darwin', 'arm64')).toBe('mac-arm64')
    expect(studioPlatform('win32', 'x64')).toBe('win-x64')
  })

  it('rejects everything else', () => {
    expect(() => studioPlatform('linux', 'x64')).toThrow(/unsupported release platform/u)
    expect(() => studioPlatform('darwin', 'x64')).toThrow(/unsupported release platform/u)
  })
})

describe('pinned Node distribution', () => {
  it('pins the stock Node version', () => {
    expect(NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it('names per-platform archives under the pinned version', () => {
    expect(nodeDistFileName('mac-arm64')).toBe(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`)
    expect(nodeDistFileName('win-x64')).toBe(`node-v${NODE_VERSION}-win-x64.zip`)
    expect(nodeDistUrl('mac-arm64')).toBe(
      `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    )
  })
})

describe('foreign native artifact pruning', () => {
  it('keeps only the current platform require-builtin shim', () => {
    expect(isForeignNativePackage('node-addon-require-builtin-darwin-arm64', 'mac-arm64')).toBe(false)
    expect(isForeignNativePackage('node-addon-require-builtin-darwin-x64', 'mac-arm64')).toBe(true)
    expect(isForeignNativePackage('node-addon-require-builtin-win32-x64', 'mac-arm64')).toBe(true)
    expect(isForeignNativePackage('node-addon-require-builtin-win32-x64', 'win-x64')).toBe(false)
    expect(isForeignNativePackage('node-addon-require-builtin-darwin-arm64', 'win-x64')).toBe(true)
  })

  it('drops only the Linux landlock binary variants, never the JS seam', () => {
    expect(isForeignNativePackage('@deepseek-ai/node-addon-landlock-run-linux-arm64', 'mac-arm64')).toBe(true)
    expect(isForeignNativePackage('@deepseek-ai/node-addon-landlock-run-linux-x64', 'mac-arm64')).toBe(true)
    expect(isForeignNativePackage('@deepseek-ai/node-addon-landlock-run-linux-x64', 'win-x64')).toBe(true)
    expect(isForeignNativePackage('@deepseek-ai/node-addon-landlock-run', 'mac-arm64')).toBe(false)
    expect(isForeignNativePackage('@deepseek-ai/node-addon-landlock-run', 'win-x64')).toBe(false)
  })

  it('keeps unrelated packages', () => {
    expect(isForeignNativePackage('node-pty', 'mac-arm64')).toBe(false)
    expect(isForeignNativePackage('@deepseek-ai/dsh-base', 'win-x64')).toBe(false)
  })

  it('names the kept node-pty prebuild directory per platform', () => {
    expect(prebuildDirName('mac-arm64')).toBe('darwin-arm64')
    expect(prebuildDirName('win-x64')).toBe('win32-x64')
  })
})

describe('closure patches', () => {
  it('records every patch with an importer and a reason', () => {
    expect(CLOSURE_PATCHES.length).toBeGreaterThan(0)
    for (const patch of CLOSURE_PATCHES) {
      expect(patch.packageName).toMatch(/^@deepseek-ai\//u)
      expect(patch.importers.length).toBeGreaterThan(0)
      expect(patch.reason.length).toBeGreaterThan(0)
    }
  })

  it('patches the app-boot runtime import that upstream declares only as a devDependency', () => {
    const groupPatch = CLOSURE_PATCHES.find(patch => patch.packageName === '@deepseek-ai/cordis-plugin-group')
    expect(groupPatch).toBeDefined()
    expect(groupPatch?.importers).toContain('@deepseek-ai/dsh-app-boot')
  })
})

describe('digestTree', () => {
  it('is deterministic across runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-digest-'))
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'x.txt'), 'one')
    writeFileSync(join(root, 'a', 'top.txt'), 'two')
    expect(digestTree(root)).toBe(digestTree(root))
  })

  it('changes when file content changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-digest-'))
    writeFileSync(join(root, 'f.txt'), 'same')
    const before = digestTree(root)
    writeFileSync(join(root, 'f.txt'), 'different')
    expect(digestTree(root)).not.toBe(before)
  })
})

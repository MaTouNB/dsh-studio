#!/usr/bin/env node
/**
 * Preset-mount probe for the staged closure: mounts the profile root include
 * and one agent preset exactly like the agent factory does (bare package
 * names resolve from the host composition's base), then prints every failing
 * row cause. The staging script parses `Cannot find package` lines from the
 * output to extend its closure patches; `PRESET MOUNT OK` means the session
 * path resolves.
 * @module @deepseek-ai/dsh-desktop/preset-probe
 */

import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { pathToFileURL } from 'node:url'

/** `argv[2]` — the host composition base (profile directory) as a URL. */
const profileBase = process.argv[2]
/** `argv[3]` — the preset composition file to mount. */
const presetPath = process.argv[3]

class PresetTree extends Include {
  import(name, getOuterStack) {
    if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
    return this.ctx.loader.internal.import(name, profileBase, {})
  }
}

const ctx = new Context()
ctx.baseUrl = profileBase
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
ctx.loader.builtins.group = Group
const rootHandle = ctx.plugin(Include, {
  path: pathToFileURL(new URL('cordis.yml', profileBase).pathname).href,
})
await rootHandle.await()
const handle = ctx.plugin(PresetTree, { path: pathToFileURL(presetPath).href })
try {
  await handle.await()
  console.log('PRESET MOUNT OK')
} catch (error) {
  const seen = new Set()
  const walk = (err, depth) => {
    if (err === null || typeof err !== 'object' || seen.has(err)) return
    seen.add(err)
    console.log(`${' '.repeat(depth)}ERROR: ${err.message ?? String(err)}`)
    if (err.errors) for (const child of err.errors) walk(child, depth + 2)
    if (err.cause) walk(err.cause, depth + 2)
  }
  walk(error, 0)
  process.exitCode = 1
}

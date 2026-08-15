// Boot the staged runtime and capture a few frames of the harness web UI
// (onboarding + the Plugins settings section) with playwright, then compose a
// short demo GIF via ImageMagick. Development aid for the release docs; the
// committed GIF at apps/desktop/docs/demo.gif is regenerated with:
//   node apps/desktop/scripts/capture-demo.mjs
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'))
const { chromium } = require('playwright')
const STAGE = join(APP_DIR, 'staging', 'mac-arm64')
const nodeBin = join(STAGE, 'node', 'bin', 'node')
const dshEntry = join(STAGE, 'dsh-cli', 'lib', 'bin.js')
const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
const secret = createHash('sha256').update(String(Date.now())).digest('base64url')

mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
writeFileSync(join(root, 'profiles', 'desktop', 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-integration'] } },
}))

const child = spawn(nodeBin, [dshEntry, '--profile', 'desktop', '--port', '0'], {
  env: { ...process.env, DSH_HOME: root, DSH_DESKTOP_SECRET: secret },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (c) => { out += String(c) })
child.stderr.on('data', (c) => { out += String(c) })

const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ready line: ${out.slice(-500)}`)), 120_000)
  const probe = setInterval(() => {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
    if (match !== null) {
      clearTimeout(timer)
      clearInterval(probe)
      resolve(match[1])
    }
  }, 500)
})

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'zh-CN' })
const shots = join(root, 'shots')
mkdirSync(shots, { recursive: true })
await page.goto(`${url}/desktop-bootstrap?token=${secret}`, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
await page.waitForTimeout(6000)
await page.screenshot({ path: join(shots, '1-onboarding.png') })
// The staged boot shows the welcome notice; acknowledge it before the shell
// is interactive (the scaffold lane pre-acknowledges it, a real boot does not).
const welcome = page.getByRole('dialog', { name: '内测声明' })
if (await welcome.count()) {
  await welcome.getByRole('button').last().click()
  await page.waitForTimeout(1500)
  const next = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
  if (await next.count()) {
    console.log('DEMO-KEY-BUTTONS:', await next.getByRole('button').allTextContents())
    const skip = next.getByRole('button', { name: '稍后配置', exact: true })
    if (await skip.count()) {
      await skip.click()
      await page.waitForTimeout(1500)
    }
  }
}
await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 30_000 })
await page.getByRole('dialog', { name: '设置' }).waitFor({ timeout: 15_000 })
await page.getByRole('button', { name: '插件', exact: true }).click()
await page.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
await page.getByRole('tab', { name: '发现', exact: true }).click()
await page.waitForTimeout(1500)
await page.screenshot({ path: join(shots, '2-plugins.png') })
await browser.close()
child.kill('SIGTERM')

const frames = readdirSync(shots).filter(name => name.endsWith('.png')).sort()
if (frames.length < 2) throw new Error('need at least two frames')
const output = join(APP_DIR, 'docs', 'demo.gif')
execFileSync('magick', [...frames.map(name => join(shots, name)), '-delay', '120', '-loop', '0', output])
console.log(`demo GIF: ${output}`)
rmSync(root, { recursive: true, force: true })
void REPO_ROOT

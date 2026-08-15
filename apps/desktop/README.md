# DSH Studio

English | [中文](README.zh.md)

*An unofficial desktop client for DeepSeek Harness.*

DSH Studio is not affiliated with or endorsed by DeepSeek.

This workspace contains the DSH Studio Electron shell and its packaged [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtime. The repository root [README](../../README.md) is the product entry point; this document is the implementation reference.

## Download

Installers ship from the [GitHub Releases page](https://github.com/MaTouNB/dsh-studio/releases) — the macOS arm64 DMG and the Windows x64 NSIS installer, with `SHA256SUMS.txt` and `runtime-manifest.json` per release. See [docs/download.md](docs/download.md) for verification, [docs/security.md](docs/security.md) for the unsigned-alpha warning, and [docs/troubleshooting.md](docs/troubleshooting.md) for issues.

## Current state

M2 through M4 are implemented and verified for macOS arm64. The packaged app supervises one Harness child through a serialized lifecycle state machine (`idle | starting | ready | restarting | stopping | failed`) with bounded crash recovery (1/2/4/8/16-second restart ladder, five unexpected exits within two minutes trip `failed` with Retry / Open Logs / Export Diagnostics / Quit actions) and process-tree teardown that reaches quiescence before the app quits. Every request is authenticated per launch: the shell generates a 256-bit base64url secret, the desktop profile's integration bundle exchanges it for an HttpOnly SameSite=Strict cookie at `/desktop-bootstrap`, and static assets, API calls, SSE, and WebSocket upgrades all reject requests without the cookie; state-changing HTTP requests must also carry the expected loopback Origin. Runtime logs rotate at 5 MiB with three retained files under the platform log directory, are redacted of the secret and credential-shaped environment values, and carry timestamps, stream, app version, Harness version, and lifecycle state. `window.dshStudio` exposes `getInfo`, `restartHarness`, `openLogs`, `exportDiagnostics`, and `onRuntimeStatus`; every IPC handler verifies the sender frame on the active loopback origin, the window refuses navigation away from it, and external links open in the system browser. Diagnostic export writes a zip of the runtime manifest, redacted logs, platform facts, profile package names and versions, and the effective configuration — never credentials, environment values, session logs, prompts, or workspace content. Plugin management (M3) runs the profile's own `dsh plugin` command against the desktop profile: `window.dshStudio` additionally exposes `searchPlugins`, `inspectPlugin`, `installPlugin`, `removePlugin`, `listPluginOperations`, and `onPluginOperation` (all sender-verified). Discovery searches the `dsh-plugin` topic and inspects candidates for archived state, submodule or missing root manifests, path-traversing bundle paths, missing built entries, and npm correspondence (a published exact version whose repository URL matches the repo); installation pins the exact version into an isolated pnpm store under the app's user data with scripts disabled by default — running lifecycle scripts requires the explicit "Allow install scripts" confirmation, which also allowlists the package in the profile's `pnpm-workspace.yaml` — and removal only touches desktop-profile-owned third-party direct dependencies. One plugin change runs at a time; operations persist across starts (`queued | running | restart-required | succeeded | failed`), interrupted records fail on the next launch, and the profile manifest change takes effect only after a restart. The plugin center (M4) adds the Discover and Manage tabs to the Plugins settings section of the harness web UI: `packages/client/ui-settings-plugin-center` (mounted only by the desktop profile, with `listInstalledPlugins` added to the bridge) drives the desktop window bridge, so search, script-confirmed installs, the operation ledger, removal, retry of failed changes, and the restart confirmation all run inside the ordinary settings surface. The Windows x64 NSIS target is configured but native-machine verification is pending.

## Staging

`pnpm run stage` ([scripts/stage-runtime.ts](scripts/stage-runtime.ts)) deterministically stages the runtime under `staging/<os>-<arch>/`:

- deploys the `@deepseek-ai/dsh` production closure with `pnpm deploy --prod --legacy`
- stages the app-owned `@deepseek-ai/dsh-desktop-integration` bundle (the loopback-authentication profile layer) into the closure
- verifies `lib/bin.js` and the Web frontend entry inside the closure
- applies recorded closure patches for upstream packages whose runtime imports are declared only as devDependencies, discovering further gaps through boot and preset-mount verification (each patch is recorded in the runtime manifest)
- hoists the closure's virtual store and mirrors every workspace-referencing link into a closure-local store, so the closure is self-contained
- prunes foreign-platform native artifacts
- downloads and verifies stock Node `22.19.0` (against nodejs.org SHASUMS256.txt) and the pinned pnpm (against the registry integrity)
- writes `runtime-manifest.json` with exact versions and SHA-256 digests

## Packaging

`pnpm run package:mac` and `pnpm run package:win` invoke Electron Builder with [electron-builder.yml](electron-builder.yml): the Electron shell is packed into ASAR, the staged runtime lands in `Resources/runtime` through `extraResources`, and artifacts are named `DSH Studio-<version>-<os>-<arch>.<ext>`. `pnpm run checksums` writes `dist/SHA256SUMS.txt`. The alpha builds are unsigned; Gatekeeper and SmartScreen warnings are expected.

## Verification

`pnpm run smoke:mac` launches the built app with a scratch DSH home and a keyless mock LLM provider, and proves the M2 surface end to end: unauthenticated requests are rejected on static assets, the API, SSE, and WebSocket upgrades; the bootstrap exchange sets the HttpOnly SameSite=Strict cookie; state-changing requests with a foreign Origin are refused; the onboarding page serves; a session runs through the web RPC API and reaches the provider; killing the Harness child recovers through the supervised restart; and quitting closes the port and leaves no process behind. The smoke runs with a PATH that contains no Node, pnpm, or Git. M3 is verified by 49 focused tests — mock GitHub and registry coverage of pagination, ETag revalidation, rate limits, bad manifests, archived and submodule repos, path traversal, missing build artifacts, exact-version selection, repository mismatch, interrupted operations, duplicate ids, script confirmation, and command-argument injection — plus an integration test that installs and removes fixture bundles through the real manager against a local mock registry and the staged runtime, and asserts the profile manifest change is only observed after a restart.

## Version and tags

[`package.json`](package.json) owns the version; it is the only place a Desktop version is written. Every release tag derives from it as `desktop-v<version>` through [releaseTag()](src/product.ts). The planned first release is `desktop-v0.1.0-alpha.1`.

## Scripts

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test
pnpm --filter @deepseek-ai/dsh-desktop run lint
pnpm --filter @deepseek-ai/dsh-desktop run stage
pnpm --filter @deepseek-ai/dsh-desktop run package:mac
pnpm --filter @deepseek-ai/dsh-desktop run package:win
pnpm --filter @deepseek-ai/dsh-desktop run checksums
pnpm --filter @deepseek-ai/dsh-desktop run smoke:mac
```

`build` runs the tsc project build and the tsdown Electron main bundle, `test` runs vitest over this workspace only, and `lint` runs oxlint over this workspace.

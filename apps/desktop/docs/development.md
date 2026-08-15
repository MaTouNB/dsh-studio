# Development

DSH Studio is an [unofficial community desktop client for DeepSeek Harness](../../../README.md), built in the `apps/desktop` workspace of the harness repository. This page covers the contributor workflow; the product roadmap and milestone acceptance live in the product Agent Note ([English](../../../.agents/notes/proposed/feature/2026-08-14-dsh-studio-desktop-product.md) | [中文](../../../.agents/notes/proposed/feature/2026-08-14-dsh-studio-desktop-product.zh.md)).

## Prerequisites

Node `^22.19 || >=24` and pnpm (the repository pins pnpm through `packageManager` in the root `package.json`). The desktop workspace adds no other system dependencies; the staging step downloads its own pinned Node and pnpm.

## Build

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test
pnpm --filter @deepseek-ai/dsh-desktop run lint
```

`build` runs the TypeScript project build, the desktop-integration bundle build (host half plus the plugin-center client bundle), the Electron main bundle, and the sandboxed preload. `test` runs the desktop vitest suite; `lint` runs oxlint over the workspace.

## Stage the runtime

`pnpm --filter @deepseek-ai/dsh-desktop run stage` deterministically builds `staging/<os>-<arch>/`: it deploys the `@deepseek-ai/dsh` production closure, stages the app-owned integration bundle and the desktop plugin-center package, hoists the virtual store, prunes foreign-platform native artifacts, downloads and verifies the pinned Node and pnpm, and runs boot and preset-mount smoke checks before writing `runtime-manifest.json`. A staged closure is required before packaging.

## Package

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package:mac   # macOS arm64 DMG
pnpm --filter @deepseek-ai/dsh-desktop run package:win   # Windows x64 NSIS installer
pnpm --filter @deepseek-ai/dsh-desktop run checksums     # writes dist/SHA256SUMS.txt
```

The packaged smoke (`pnpm run smoke:mac`) launches the built app with a scratch DSH home and a keyless mock provider, and proves the loopback authentication matrix, one session, supervised crash recovery, and clean shutdown. The Windows installed-artifact smoke (`pnpm run smoke:installed:win`) silent-installs the NSIS package and verifies the payload and uninstall.

## Run from source

In a source checkout, `pnpm run smoke:mac` and the packaged boot use the staged closure; the dev harness link (`linkDevIntegrationBundle` in `src/main.ts`) makes the app-owned bundles resolvable from the desktop profile. The release drill is `pnpm run verify:release`, which pins the tag, installers, checksums, and runtime manifests against the package version — see [release.md](release.md).

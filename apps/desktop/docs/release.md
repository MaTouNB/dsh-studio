# Release

This page documents the release contract for DSH Studio: versions, tags, the CI workflow, and the non-publishing drill that produces the release evidence. The first public release is `desktop-v0.1.0-alpha.1`.

## Version and tag contract

`apps/desktop/package.json` owns the version; every release tag derives from it as `desktop-v<version>` through [releaseTag()](../src/product.ts). The tag filter in the release workflow accepts only `desktop-v*` tags, and the workflow builds both installers from the tagged commit's own source (immutable install of the pinned toolchain, no mutable downloads).

## Artifacts

A release publishes `DSH Studio-<version>-mac-arm64.dmg`, `DSH Studio-<version>-win-x64.exe`, `SHA256SUMS.txt`, and `runtime-manifest.json` (see [download.md](download.md)). `runtime-manifest.json` records the bundled Harness version (`components.dsh.version`) and the pinned Node and pnpm with tree hashes, so a release's built-in runtime is checkable before install.

## CI workflows

- `desktop-build.yml` runs on pull requests: each platform job (macOS arm64 on `macos-15`, Windows x64 on `windows-2025`) stages the runtime, packages its installer, writes checksums, and runs its smoke, then uploads the artifacts as CI evidence.
- `desktop-release.yml` runs on `desktop-v*` tags: it rebuilds the same matrix, verifies the release facts with `verify:release`, and a single release job with write permission creates the draft release from the uploaded installers, checksums, and runtime manifest.

## The non-publishing drill

Before any tag, run the drill locally on macOS:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run stage
pnpm --filter @deepseek-ai/dsh-desktop run package:mac
pnpm --filter @deepseek-ai/dsh-desktop run package:win
pnpm --filter @deepseek-ai/dsh-desktop run checksums
pnpm --filter @deepseek-ai/dsh-desktop run verify:release
```

The drill produces both installers and the test evidence (the packaged smoke, the Windows installed-artifact smoke, and the consistency verification) without touching GitHub. Creating the draft release itself requires repository write access and is performed from the `desktop-v*` tag by the release workflow.

## Draft release contents

The draft release title and tag are `desktop-v<version>`. Its bilingual body names the product as an unofficial client, links the download and security pages in both languages, states that the alpha builds are unsigned, and lists the bundled Harness version from `runtime-manifest.json` — all facts `verify:release` pins before the release job runs.

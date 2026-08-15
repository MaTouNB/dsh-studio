# DSH Studio

English | [中文](README.zh.md)

*An unofficial community desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).*

DSH Studio is not affiliated with or endorsed by DeepSeek. The project is in alpha, and its installers are unsigned.

![DSH Studio demonstration](apps/desktop/docs/demo.gif)

## What it provides

DSH Studio packages the Harness Web UI, a pinned Harness runtime, and an Electron shell into one desktop application. The shell starts and supervises the bundled runtime, authenticates loopback traffic, exposes redacted diagnostics, and keeps desktop plugin changes inside an app-owned profile.

- macOS arm64 DMG and Windows x64 NSIS packaging targets
- supervised Harness startup, restart, crash recovery, and process-tree shutdown
- per-launch loopback authentication for HTTP, SSE, and WebSocket traffic
- Discover and Manage views for exact-version Harness plugin installation
- release manifests, checksums, diagnostics export, and bilingual operator documentation

## Download

Installers and checksums are published on the [Releases page](https://github.com/MaTouNB/dsh-studio/releases). Read the [download guide](apps/desktop/docs/download.md) before installing and the [security notice](apps/desktop/docs/security.md) before bypassing Gatekeeper or SmartScreen warnings.

| Target | Status |
| --- | --- |
| macOS arm64 | Implemented and locally verified |
| Windows x64 | Packaging and CI target configured; native release verification remains required |

<a id="run"></a>

## Harness Web UI

DSH Studio embeds the Harness Web UI. To run that UI in a browser without the Electron shell, install Node.js and run:

```sh
npx @deepseek-ai/dsh web
```

The server listens on `http://127.0.0.1:3080` by default.

<a id="run-from-source"></a>

### Run Harness from source

```sh
git clone https://github.com/MaTouNB/dsh-studio.git
cd dsh-studio
pnpm install
pnpm run build
pnpm dsh web
```

## Development

The desktop application remains in the Harness monorepo because it consumes Harness workspace packages directly. Start with the [desktop development guide](apps/desktop/docs/development.md), then use the workspace commands:

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test
pnpm --filter @deepseek-ai/dsh-desktop run lint
```

The Electron application is under [`apps/desktop`](apps/desktop/). Its desktop-only Plugin Center client package is under [`packages/client/ui-settings-plugin-center`](packages/client/ui-settings-plugin-center/).

## Documentation

- [Download and verification](apps/desktop/docs/download.md)
- [Security model and unsigned-alpha warning](apps/desktop/docs/security.md)
- [Troubleshooting](apps/desktop/docs/troubleshooting.md)
- [Release process](apps/desktop/docs/release.md)
- [Desktop implementation reference](apps/desktop/README.md)
- [Harness architecture](docs/architecture.md)

## Upstream relationship

This repository is a fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and retains its plugin architecture and upstream history. DSH Studio-specific development and releases are maintained in this repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party dependencies and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

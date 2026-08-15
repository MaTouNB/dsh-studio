# DSH Studio

[English](README.md) | 中文

*基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方社区桌面客户端。*

DSH Studio 与 DeepSeek 无关联，亦未获其背书。项目目前处于 alpha 阶段，安装包尚未签名。

![DSH Studio 演示](apps/desktop/docs/demo.gif)

## 功能

DSH Studio 将 Harness Web UI、固定版本的 Harness 运行时与 Electron 壳打包为一个桌面应用。Electron 壳负责启动并托管内置运行时、鉴权回环流量、导出脱敏诊断信息，并将桌面插件变更限制在应用自有 profile 中。

- macOS arm64 DMG 与 Windows x64 NSIS 打包目标
- Harness 启动、重启、崩溃恢复与进程树退出托管
- HTTP、SSE 与 WebSocket 流量的逐次启动回环鉴权
- 按精确版本安装 Harness 插件的「发现」与「管理」界面
- 发行清单、校验和、诊断导出与双语运维文档

## 下载

安装包与校验和发布在 [Releases 页面](https://github.com/MaTouNB/dsh-studio/releases)。安装前请阅读[下载指南](apps/desktop/docs/download.md)；绕过 Gatekeeper 或 SmartScreen 警告前请阅读[安全说明](apps/desktop/docs/security.md)。

| 目标平台 | 状态 |
| --- | --- |
| macOS arm64 | 已实现并完成本地验证 |
| Windows x64 | 已配置打包与 CI 目标；仍需原生环境发行验证 |

<a id="run"></a>

## Harness Web UI

DSH Studio 内嵌 Harness Web UI。如需脱离 Electron 壳在浏览器中运行该界面，请安装 Node.js 并执行：

```sh
npx @deepseek-ai/dsh web
```

服务默认监听 `http://127.0.0.1:3080`。

<a id="run-from-source"></a>

### 从源码运行 Harness

```sh
git clone https://github.com/MaTouNB/dsh-studio.git
cd dsh-studio
pnpm install
pnpm run build
pnpm dsh web
```

## 开发

桌面应用直接使用 Harness workspace 包，因此保留在 Harness monorepo 中。请先阅读[桌面开发指南](apps/desktop/docs/development.md)，再运行 workspace 命令：

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test
pnpm --filter @deepseek-ai/dsh-desktop run lint
```

Electron 应用位于 [`apps/desktop`](apps/desktop/)，仅供桌面端使用的插件中心客户端包位于 [`packages/client/ui-settings-plugin-center`](packages/client/ui-settings-plugin-center/)。

## 文档

- [下载与校验](apps/desktop/docs/download.md)
- [安全模型与未签名 alpha 警告](apps/desktop/docs/security.md)
- [问题排查](apps/desktop/docs/troubleshooting.md)
- [发行流程](apps/desktop/docs/release.md)
- [桌面端实现参考](apps/desktop/README.md)
- [Harness 架构](docs/architecture.md)

## 与上游的关系

本仓库 fork 自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，保留其插件架构与上游历史。DSH Studio 专属开发与发行由本仓库维护。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

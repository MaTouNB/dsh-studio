# DSH Studio

[English](README.md) | 中文

*DeepSeek Harness 桌面客户端。*

本 workspace 包含 DSH Studio Electron 壳及其打包的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 运行时。仓库根 [README](../../README.md) 是产品入口；本文是实现参考。

## 下载

安装程序从 [GitHub Releases 页面](https://github.com/MaTouNB/dsh-studio/releases) 发布——macOS arm64 DMG 与 Windows x64 NSIS 安装程序，每个发行版附 `SHA256SUMS.txt` 与 `runtime-manifest.json`。校验见 [docs/download.md](docs/download.md)，未签名 alpha 警告见 [docs/security.md](docs/security.md)，问题排查见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 当前状态

M2 至 M4 已在 macOS arm64 上实现并验证。打包应用通过串行生命周期状态机（`idle | starting | ready | restarting | stopping | failed`）托管唯一一个 Harness 子进程，具备有界崩溃恢复（1/2/4/8/16 秒重启阶梯，两分钟内五次意外退出进入 `failed`，提供重试/打开日志/导出诊断/退出操作）与达到静默的进程树清理。每个请求都按启动鉴权：壳生成 256 位 base64url 密钥，desktop profile 的集成 bundle 在 `/desktop-bootstrap` 用密钥换取 HttpOnly SameSite=Strict cookie，静态资源、API、SSE 与 WebSocket upgrade 全部拒绝无 cookie 请求；状态变更 HTTP 请求还必须携带预期的回环 Origin。运行时日志在平台日志目录按 5 MiB 轮转、保留三份，脱敏密钥与凭据形态的环境变量值，并携带时间戳、stream、应用版本、Harness 版本与生命周期状态。`window.dshStudio` 暴露 `getInfo`、`restartHarness`、`openLogs`、`exportDiagnostics` 与 `onRuntimeStatus`；每个 IPC handler 验证发送 frame 处于活动回环 origin，窗口拒绝离开它的导航，HTTP/HTTPS 外链用系统浏览器打开。诊断导出生成包含运行时清单、脱敏日志、平台事实、profile 包名与版本及有效配置的 zip——绝不含凭据、环境变量值、会话日志、提示词或 workspace 内容。插件管理（M3）对 desktop profile 运行其自有 `dsh plugin` 命令：`window.dshStudio` 另暴露 `searchPlugins`、`inspectPlugin`、`installPlugin`、`removePlugin`、`listPluginOperations` 与 `onPluginOperation`（全部经 sender 校验）。发现按 `dsh-plugin` topic 搜索，并检查候选的归档状态、submodule 或缺失的根 manifest、路径穿越的 bundle 路径、缺失构建产物与 npm 对应关系（已发布且仓库 URL 与仓库匹配的精确版本）；安装把精确版本钉进应用用户数据下的隔离 pnpm store，脚本默认禁用——运行生命周期脚本需要显式「允许安装脚本」确认，该确认同时把包加入 profile 的 `pnpm-workspace.yaml` allowlist——删除只触及 desktop-profile 自有的第三方直接依赖。同一时间只运行一个插件变更；操作跨启动持久化（`queued | running | restart-required | succeeded | failed`），中断记录在下次启动时转为 `failed`，profile 清单变化只在重启后生效。插件中心（M4）向 Harness Web UI 的 Plugins 设置分区加入「发现」与「管理」标签页：`packages/client/ui-settings-plugin-center`（仅由 desktop profile 挂载，桥另增 `listInstalledPlugins`）驱动桌面窗口桥，搜索、脚本确认安装、操作记录、删除、失败变更重试与重启确认都在常规设置界面内完成。Windows x64 NSIS 目标已配置，但原生机器验证待完成。

## 暂存

`pnpm run stage`（[scripts/stage-runtime.ts](scripts/stage-runtime.ts)）在 `staging/<os>-<arch>/` 下确定性暂存运行时：

- 用 `pnpm deploy --prod --legacy` 部署 `@deepseek-ai/dsh` 生产闭包
- 把 app-owned 的 `@deepseek-ai/dsh-desktop-integration` bundle（回环鉴权 profile 层）暂存进闭包
- 校验闭包内的 `lib/bin.js` 与 Web 前端入口
- 对上游只在 devDependencies 中声明运行时导入的包应用已记录的闭包补丁，并通过引导与 preset 挂载验证继续发现缺口（每个补丁都记录在运行时清单中）
- 提升闭包的虚拟商店，并把所有指向 workspace 的链接镜像到闭包内商店，使闭包自包含
- 裁剪其他平台的原生产物
- 下载并校验原版 Node `22.19.0`（对照 nodejs.org SHASUMS256.txt）与固定 pnpm（对照 registry integrity）
- 写入带精确版本与 SHA-256 摘要的 `runtime-manifest.json`

## 打包

`pnpm run package:mac` 与 `pnpm run package:win` 调用 Electron Builder（[electron-builder.yml](electron-builder.yml)）：Electron 壳打入 ASAR，暂存运行时通过 `extraResources` 进入 `Resources/runtime`，产物命名为 `DSH Studio-<version>-<os>-<arch>.<ext>`。`pnpm run checksums` 写入 `dist/SHA256SUMS.txt`。alpha 构建未签名；Gatekeeper 与 SmartScreen 警告属预期。

## 验证

`pnpm run smoke:mac` 用临时 DSH home 与 keyless mock LLM provider 启动打包应用，端到端验证 M2 表面：未鉴权请求在静态资源、API、SSE 与 WebSocket upgrade 上全部被拒；bootstrap 交换设置 HttpOnly SameSite=Strict cookie；携带外域 Origin 的状态变更请求被拒；onboarding 页面可访问；会话经 Web RPC API 运行并到达 provider；杀死 Harness 子进程后经受管重启恢复；退出关闭端口且不留任何进程。冒烟运行在不含 Node、pnpm 或 Git 的 PATH 下。M3 由 49 个聚焦测试验证——mock GitHub 与 registry 覆盖分页、ETag 重新校验、限额、错误 manifest、归档与 submodule 仓库、路径穿越、缺失构建产物、精确版本选择、仓库不匹配、中断操作、重复 id、脚本确认与命令参数注入——另有集成测试通过真实 manager 在本地 mock registry 与暂存运行时之上安装并删除 fixture bundle，并断言 profile 清单变化只在重启后观察得到。

## 版本与标签

[`package.json`](package.json) 拥有版本；它是唯一写入 Desktop 版本的位置。每个发布标签通过 [releaseTag()](src/product.ts) 从它派生为 `desktop-v<version>`。规划中的首个发布为 `desktop-v0.1.0-alpha.1`。

## 脚本

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

`build` 运行 tsc 项目构建与 tsdown Electron main 打包，`test` 仅运行本 workspace 的 vitest，`lint` 仅对本 workspace 运行 oxlint。

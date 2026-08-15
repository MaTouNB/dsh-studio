# 开发

DSH Studio 是 [DeepSeek Harness](../../../README.md) 的[非官方社区桌面客户端](../../../README.md)，构建于仓库的 `apps/desktop` workspace。本页覆盖贡献者工作流；产品路线图与里程碑验收见产品 Agent Note（[English](../../../.agents/notes/proposed/feature/2026-08-14-dsh-studio-desktop-product.md) | [中文](../../../.agents/notes/proposed/feature/2026-08-14-dsh-studio-desktop-product.zh.md)）。

## 前置条件

Node `^22.19 || >=24` 与 pnpm（仓库通过根 `package.json` 的 `packageManager` 固定 pnpm）。桌面 workspace 无其它系统依赖；staging 步骤会自行下载固定的 Node 与 pnpm。

## 构建

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run test
pnpm --filter @deepseek-ai/dsh-desktop run lint
```

`build` 运行 TypeScript 项目构建、desktop-integration bundle 构建（host 半部 + plugin-center client bundle）、Electron 主进程 bundle 与沙箱 preload。`test` 运行桌面 vitest 套件；`lint` 用 oxlint 检查本 workspace。

## 暂存运行时

`pnpm --filter @deepseek-ai/dsh-desktop run stage` 确定性构建 `staging/<os>-<arch>/`：部署 `@deepseek-ai/dsh` 生产闭包、暂存 app-owned 的集成 bundle 与桌面 plugin-center 包、提升虚拟商店、裁剪其他平台的原生产物、下载并校验固定的 Node 与 pnpm，并在写入 `runtime-manifest.json` 前运行引导与 preset 挂载冒烟。打包前必须先有暂存闭包。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package:mac   # macOS arm64 DMG
pnpm --filter @deepseek-ai/dsh-desktop run package:win   # Windows x64 NSIS 安装程序
pnpm --filter @deepseek-ai/dsh-desktop run checksums     # 写入 dist/SHA256SUMS.txt
```

打包冒烟（`pnpm run smoke:mac`）用临时 DSH home 与 keyless mock provider 启动构建产物，验证回环鉴权矩阵、一个会话、受管崩溃恢复与干净退出。Windows 安装产物冒烟（`pnpm run smoke:installed:win`）静默安装 NSIS 包并验证载荷与卸载。

## 从源码运行

源码检出下，`pnpm run smoke:mac` 与打包式引导使用暂存闭包；开发链接（`src/main.ts` 的 `linkDevIntegrationBundle`）使 app-owned bundle 从 desktop profile 可解析。发布演练为 `pnpm run verify:release`，把标签、安装包、校验和与运行时清单钉在包版本上——见 [release.md](release.md)。

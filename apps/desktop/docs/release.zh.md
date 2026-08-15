# 发布

本页记录 DSH Studio 的发布契约：版本、标签、CI workflow 与产出发布证据的非发布演练。首个公开版本为 `desktop-v0.1.0-alpha.1`。

## 版本与标签契约

`apps/desktop/package.json` 拥有版本；每个发布标签经 [releaseTag()](../src/product.ts) 派生为 `desktop-v<version>`。发布 workflow 的标签过滤只接受 `desktop-v*` 标签，并从标签对应 commit 的源码构建两个安装包（固定工具链不可变安装，无可变下载）。

## 产物

一个发行版发布 `DSH Studio-<version>-mac-arm64.dmg`、`DSH Studio-<version>-win-x64.exe`、`SHA256SUMS.txt` 与 `runtime-manifest.json`（见 [download.md](download.md)）。`runtime-manifest.json` 记录内置 Harness 版本（`components.dsh.version`）与固定 Node、pnpm 及树哈希，因此发行版的内置运行时在安装前即可核对。

## CI workflow

- `desktop-build.yml` 在 pull request 上运行：每个平台 job（macOS arm64 用 `macos-15`、Windows x64 用 `windows-2025`）暂存运行时、打包其安装程序、写入校验和并运行其冒烟，然后上传产物作为 CI 证据。
- `desktop-release.yml` 在 `desktop-v*` 标签上运行：重建同一矩阵，用 `verify:release` 校验发布事实，然后唯一的 release job（带写权限）从上传的安装程序、校验和与运行时清单创建 draft release。

## 非发布演练

打任何标签前，在本地 macOS 运行演练：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run stage
pnpm --filter @deepseek-ai/dsh-desktop run package:mac
pnpm --filter @deepseek-ai/dsh-desktop run package:win
pnpm --filter @deepseek-ai/dsh-desktop run checksums
pnpm --filter @deepseek-ai/dsh-desktop run verify:release
```

演练产出两个安装包与测试证据（打包冒烟、Windows 安装产物冒烟与一致性校验），不触碰 GitHub。创建 draft release 本身需要仓库写权限，由发布 workflow 从 `desktop-v*` 标签执行。

## Draft release 内容

draft release 的标题与标签为 `desktop-v<version>`。双语正文把产品标注为非官方客户端，链接中英下载与安全页，说明 alpha 构建未签名，并列出 `runtime-manifest.json` 中的内置 Harness 版本——这些事实都在 release job 运行前由 `verify:release` 钉住。

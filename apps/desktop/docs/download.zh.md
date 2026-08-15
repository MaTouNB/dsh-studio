# 下载

DSH Studio 从 [GitHub Releases 页面](https://github.com/MaTouNB/dsh-studio/releases) 分发。每个发行版同时发布两个安装包——macOS arm64 DMG 与 Windows x64 NSIS 安装程序——以及 `SHA256SUMS.txt` 与 `runtime-manifest.json`。发行标题标注确切的 `desktop-v<version>` 标签，并链接随附的校验和（alpha 期间为未签名）。

## 演示

![DSH Studio 演示](demo.gif)

一窥引导页与插件中心（发现标签页）。

## 产物

| 文件 | 平台 | 格式 |
|---|---|---|
| `DSH Studio-<version>-mac-arm64.dmg` | macOS arm64 | 磁盘映像 |
| `DSH Studio-<version>-win-x64.exe` | Windows x64 | NSIS 安装程序 |
| `SHA256SUMS.txt` | 全部 | 安装包的 SHA-256 摘要 |
| `runtime-manifest.json` | 全部 | 暂存运行时的精确版本与树哈希 |

alpha 构建未签名；macOS Gatekeeper 与 Windows SmartScreen 会显示警告。其含义见 [security.md](security.md)，警告阻止安装时见 [troubleshooting.md](troubleshooting.md)。

## 校验下载

`SHA256SUMS.txt` 列出每个安装包的摘要。macOS：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Windows PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 "DSH Studio-<version>-win-x64.exe"
```

把输出与 `SHA256SUMS.txt` 条目比对。`runtime-manifest.json` 标注内置 Harness 版本以及固定的 Node 与 pnpm，安装前即可确认发行版携带的运行时。

## 选择版本

首个公开版本为 `desktop-v0.1.0-alpha.1`。alpha 发行版不提供稳定性承诺；版本与标签契约见 [release.md](release.md)。

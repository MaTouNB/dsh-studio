# 故障排查

本页覆盖 DSH Studio 的常见失败模式，以及上报所需证据的收集方式。安装警告见 [security.md](security.md)；产物清单见 [download.md](download.md)。

## 日志

应用在平台日志目录写轮转 JSON 行（macOS：`~/Library/Logs/DSH Studio/`；Windows：`%LOCALAPPDATA%\DSH Studio\logs\`）。每行带时间戳、stream、应用版本、Harness 版本与生命周期状态；密钥与凭据形态的环境变量值在写入前脱敏。

## 诊断导出

设置界面的「导出诊断」动作写入一个 zip，包含运行时清单、脱敏日志、平台事实、profile 包名与版本及有效配置——绝不含凭据、环境变量值、会话日志、提示词或 workspace 内容。把它附到 bug 报告里。

## 窗口无法到达应用

窗口打开 harness Web UI 的回环端口（子进程就绪时打印）。窗口空白时打开日志查看是否有 `failed` 生命周期状态；监督器提供重试/打开日志/导出诊断/退出操作。两分钟内反复崩溃会按设计进入受保护的失败状态。

## 安装警告

Gatekeeper（「无法验证开发者」）与 SmartScreen（「Windows 已保护你的电脑」）警告出现是因为 alpha 安装程序未签名。校验校验和后，macOS 右键→打开，Windows 更多信息→仍要运行。若警告指向不同发布者，请停止并上报。

## 插件安装失败

安装针对 desktop profile 运行其自有 `dsh plugin` 命令。失败操作在管理页显示诊断代码（例如包需要生命周期脚本时的 `scripts-not-confirmed`，或 pnpm 失败时的 `launcher-failed`）。解决原因后重试；profile 只在成功的 restart-required 操作后才会变更。

## 卸载

macOS：把应用拖入废纸篓。Windows：从安装目录或「程序和功能」运行 NSIS 卸载程序。DSH home（macOS `~/.dsh`，Windows `%USERPROFILE%\.dsh`）存放会话、设置与已安装插件；删除它会清除这些数据。

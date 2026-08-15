# 安全

DSH Studio 是非官方、社区维护的桌面客户端，与 DeepSeek 无关联亦未获其背书。只从 [GitHub Releases 页面](https://github.com/MaTouNB/dsh-studio/releases) 安装发行版，校验校验和（[download.md](download.md)），并把其它任何来源视为不可信。

## alpha 签名状态

alpha 安装程序未签名。macOS Gatekeeper 与 Windows SmartScreen 会相应警告。未签名警告是 alpha 构建的预期；若安装程序未通过校验和验证，或警告中的发布者不是你信任的身份，请勿安装——改为上报异常（[troubleshooting.md](troubleshooting.md)）。

## 按启动回环鉴权

桌面应用在回环地址运行自己的 Harness 子进程，并带每次启动的随机密钥。窗口用密钥换取 HttpOnly、SameSite=Strict cookie；静态资源、API、SSE 与 WebSocket upgrade 全部拒绝无 cookie 请求，状态变更请求还必须携带预期的回环 Origin。密钥绝不写入日志。

## 凭据与诊断

API Key 与凭据由 harness 凭据服务存放在 DSH home 下，绝不进入导出的诊断：诊断 zip 按构造排除凭据、环境变量值、会话日志、提示词与 workspace 内容。分享前请审阅诊断导出，因为它包含平台事实与配置。

## 插件管理

已安装插件在 Harness 进程内运行任意代码。安装脚本默认禁用，只在显式「允许安装脚本」确认后运行（[../README.md](../README.md)）；安装前请审阅插件源码与 npm 对应关系。删除只触及 desktop-profile 自有的第三方直接依赖。

## 上报

安全问题不要公开提交 issue：请发邮件给仓库维护者（项目所有者 GitHub 主页上的联系方式），附上复现步骤。非安全问题使用 issue 跟踪器。

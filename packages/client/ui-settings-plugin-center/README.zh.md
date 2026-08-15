# @deepseek-ai/dsh-client-ui-settings-plugin-center

[English](README.md) | 中文

桌面插件中心的浏览器端贡献：现有 Plugins 设置分区里的两个标签页——**发现**（按 `dsh-plugin` topic 搜索、检查候选、确认安装脚本、安装精确版本）与**管理**（已安装的桌面 profile 插件、持久化操作记录、删除与失败变更重试）。两个标签页都通过只有 DSH Studio Electron 壳提供的 `window.dshStudio` 桥工作；在其它部署上只显示桌面端提示。

桌面 profile 通过 desktop-integration bundle 的补丁挂载本包（行 `desktop-plugin-center`）；打包运行时把它作为 `@deepseek-ai/dsh-web-app` bundle 的依赖随发。

## 当前行为

- 注册 `settings.plugins.tab` 条目 `discover`（顺序 5）与 `manage`（顺序 6），并注册 `settings.pluginCenter` 语言字典。
- 桥访问器经注入提供（绝不导入）：标签页惰性读取 `window.dshStudio`，缺失时退化为提示。
- 安装脚本确认是强制的：候选的精确版本声明生命周期脚本或原生构建步骤时，安装前先询问「允许安装脚本」。
- `restart-required` 操作弹出重启确认，调用桥的 `restartHarness`。
- 管理页可重试失败操作；`scripts-not-confirmed` 失败会重新询问脚本确认，而不是静默重试。

## 开发

`pnpm run bundle` 经共享 client-bundle 预设构建 `lib/client.js`（平台模块 external + module-table 交接）。组件与插件测试在根 vitest 配置的 jsdom 通道运行。

## 模型体验

### 桌面桥表面

#### 模型看到什么

无：插件中心标签页只在浏览器设置内驱动 `window.dshStudio` 桥（`searchPlugins`、`inspectPlugin`、`installPlugin`、`removePlugin`、`listInstalledPlugins`、`restartHarness`）。不注册任何模型相关能力，也不增加任何提示词段。

#### Token 影响

无：标签页不产生任何模型 token；不组装也不发送模型输入。

#### KV 缓存影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与待办

- **仅桌面桥可用** —— 在普通 Harness Web 部署上，因为 `window.dshStudio` 只存在于 DSH Studio Electron 壳中，标签页只显示桌面端提示。
- **重试使用安全默认** —— 重试 `scripts-not-confirmed` 之外的失败安装时以不运行脚本的方式重新提交；需要脚本的包必须再经过发现页或确认门禁确认。

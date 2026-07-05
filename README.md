# 花酿（Hanabrew）

> 基于 SillyTavern 1.18.0 (AGPL-3.0) 的 HanaAgent 插件 · v1.0
>
> 修改版源码：https://github.com/moononnn/hanabrew
> 原版 ST：https://github.com/SillyTavern/SillyTavern

在 HanaAgent 里运行原生 SillyTavern 1.18.0。点菜单弹出 Edge 独立窗口，完整酒馆体验 + 助手实时调试。

## 前置条件

- **HanaAgent**（插件运行平台）
- **Node.js 18+**（花酿需要 node 命令启动 ST 服务器）
- **Edge 浏览器**（Windows 11 自带；Win10 用户需自行安装）

## 安装

把 `hanabrew/` 文件夹放到 `C:\Users\<你的用户名>\.hanako\plugins\` 下，重启 HanaAgent 即可。

Hana 插件面板 → 找到「花酿」→ 确认已启用（默认启用）。

## 使用

1. 在 Hana 左侧菜单点「花酿」
2. 等待几秒，ST 服务器首次启动需要编译前端（约 15 秒）
3. Edge 独立窗口自动弹出，进入 SillyTavern
4. 填 API Key → 连接 → 开始聊天

### 助手调试

助手可以通过 agent 工具直接读写 ST 数据。建议配合以下 skill 使用：

| Skill | 作用 | 安装方式 |
|-------|------|---------|
| `tavern-cards`（写卡流程） | 编写 SillyTavern 角色卡和世界书 | 推荐从 [ai4rpg/tavern-cards](https://github.com/ai4rpg/tavern-cards) 安装（感谢作者提供的写卡 skill） |
| `hanabrew-card-testing`（花酿测卡流程） | 在花酿中导入和测试角色卡 | 插件包内的 `skills/hanabrew-card-testing/` 文件夹复制到 `.hanako/skills/` 下重启生效 |

> **安装 skill 的方法**：把你下载的插件包解压，找到 `skills/` 文件夹，把里面每个 skill 文件夹复制到 `C:\Users\<你的用户名>\.hanako\skills\` 下（如果没有这个文件夹就自己建一个），然后重启 HanaAgent。

助手可以通过 agent 工具直接读写 ST 数据：

| 工具 | 作用 |
|------|------|
| `tavern-list-characters` | 列出所有角色 |
| `tavern-load-character` | 读取角色详情 |
| `tavern-save-character` | 创建/更新角色 |
| `tavern-delete-character` | 删除角色 |
| `tavern-import-character` | 导入角色 JSON |
| `tavern-chat` | 和角色聊天测试 |
| `tavern-debug` | 查看插件状态和日志 |
| `tavern-worldbook` | 操作世界书 |
| `tavern-settings` | 读写设置 |

## 注意事项

- **不支持 Hana 内嵌 webview**，必须用外部浏览器。Edge 是默认选择，Windows 11 自带。
- 数据存储在 `%APPDATA%\hanabrew\st-data\default-user\`，卸载插件不会自动删除数据。
- 首次启动 ST 需要编译前端，耗时约 10-15 秒，之后只需 1 秒。
- 如果你在调试时遇到问题，F12 打开 Edge 开发者工具查看前端错误，同时助手可以用 `tavern-debug` 看后端日志。

## 技术栈

- 原生 SillyTavern 1.18.0（完整源码，含 node_modules）
- HanaAgent 插件 API（页面 + agent 工具）
- Edge `--app` 模式独立窗口

## 附赠：花酿测卡 skill

花酿内置了 `hanabrew-card-testing` skill，**首次启动时会自动复制到 `~/.hanako/skills/`**（已存在则跳过，不会覆盖你手动安装的版本）。让 AI 助手在花酿里写卡、测卡时自动激活。

如果自动安装没生效，可以手动把 `hanabrew/skills/hanabrew-card-testing/` 文件夹复制到 `~/.hanako/skills/` 下。

## 许可

AGPL-3.0

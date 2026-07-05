---
name: hanabrew-card-testing
description: "花酿（Hanabrew）测卡配套流程。在花酿中从零创建、打包、导入并测试 SillyTavern 角色卡。MANDATORY TRIGGERS：花酿测卡、测卡流程、hanabrew 测试、花酿配套、写卡后导入花酿、hanabrew import、花酿导入角色。当用户在花酿平台写完角色卡后想要测试时触发。也适用于花酿相关的任何角色卡导入、调试、排查问题。"
---

# 花酿测卡流程

花酿是 HanaAgent 的社区插件，在 Hana 内部原生运行 SillyTavern 1.18.0。写卡后用本 skill 完成剩余步骤：打包 → 导入花酿 → 验证。

## 效率分工

花酿使用中涉及的操作按效率分配——不是「谁不能做」，而是「谁做更快」：

**AI 助手做更快的事（后端）：**
- 角色卡内容创作
- 调用 tavern-cards-forge 打包
- 通过 ST API 导入角色卡（multipart POST）
- 日志和文件系统检查
- 端口扫描和连通性检测
- 代码级的排查和修复

**用户做更快的事（前端）：**
- 在花酿 UI 界面上点按钮、看界面
- 截图反馈渲染效果
- 描述界面上看到的现象

原则：发现需要操作花酿前端界面时（点「世界书」「角色管理」等按钮），AI 直接告诉用户点哪里、看什么，而不是自己去截图找按钮绕一大圈。用户点两下鼠标的事，不值得让 AI 花几十秒截图分析。

## 前置条件

- 花酿插件（hanabrew）已安装且显示在 Hana 左侧菜单
- tavern-cards 写卡 skill 已完成角色卡内容创作
- 角色卡项目已包含至少一次 `pack` 输出

## 完整流程

### 第一步：确保花酿启动

花酿启动后会在后台启动 SillyTavern 服务器。用户点击 Hana 左侧菜单「花酿」即可启动。启动后 ST 服务器端口**每次都是随机分配的**。

### 第二步：获取 SillyTavern 端口

花酿的 ST 端口**不是固定的**（重启后可能变为 3110、9900、11038 等任意端口）。有两种方式获取：

**方法 A（推荐）：查看 Hana 活动日志**
从 `plugin_dev_diagnostics` 输出的日志中搜索 `st=http://127.0.0.1:` 可以找到当前端口。

**方法 B：扫描端口**
尝试连接 `http://127.0.0.1:{port}/`，响应 200 的端口即为 ST 端口。

记录下端口号，后续全部 API 调用都需要用到。

### 第三步：打包角色卡

在 tavern-cards 项目目录下执行 `pack` 命令：

```bash
node scripts/tavern-cards-forge.mjs pack {项目名}
```

输出产物位于项目目录下的 `{项目名}.json`（或 `{项目名}.png`，有头像时）。

### 第三步半：清缓存 + 删旧世界书（按需）

**不是每次都要清。** 只在以下情况执行：
- 改动了世界书条目（内容、关键词、EJS 等）→ 需要删除世界书
- 只改了角色描述、开场白、扮演准则等不涉及世界书的内容 → **跳过**

需要清缓存时：调用 `清理缓存` skill 按步骤执行。关键命令：

```powershell
# 删除独立世界书（否则 ST 会同时读新旧两份，旧版 EJS 代码会报错）
Remove-Item "$env:APPDATA\hanabrew\st-data\default-user\worlds\{角色名}.json" -Force
# 清角色缓存
Remove-Item "$env:APPDATA\hanabrew\st-data\_cache\characters\*" -Force
# 删旧角色 PNG
Remove-Item "$env:APPDATA\hanabrew\st-data\default-user\characters\{角色名}.png" -Force
# 删旧聊天记录（否则开场白残留旧版本）
Remove-Item "$env:APPDATA\hanabrew\st-data\default-user\chats\{角色名}" -Recurse -Force -ErrorAction SilentlyContinue
```

### 第三步三半：修复 tavern_helper 格式（按需）

tavern-cards-forge 打包时 `extensions.tavern_helper` 输出为对象格式 `{"scripts":[...]}`，但 SillyTavern 需要**数组格式** `[["scripts",[...]]]`（ST 内部存储对象的序列化方式）。不改的话 MVU 脚本不会被识别，额外模型变量解析不可用。

```javascript
// 导入前对打包后的 JSON 执行
const d = JSON.parse(fs.readFileSync('cards/{项目名}/{项目名}.json','utf-8'));
const helper = d.data.extensions.tavern_helper;
if (helper && helper.scripts && !Array.isArray(helper)) {
  d.data.extensions.tavern_helper = [
    ['scripts', helper.scripts],
    ['variables', helper.variables || {}]
  ];
  fs.writeFileSync('cards/{项目名}/{项目名}.json', JSON.stringify(d, null, 2), 'utf-8');
}
```

## 第四步：导入花酿

通过 SillyTavern API 导入角色卡。**不要使用花酿后端的 `importCharacter` 工具函数——它只保存基础字段，会丢失世界书、正则脚本和 MVU 脚本。**

正确的调用方式——向 ST 发送 multipart POST 请求：

```
POST http://127.0.0.1:{端口}/api/characters/import
Content-Type: multipart/form-data

字段 "avatar"（name 必须为 avatar，不是 file）：角色卡 JSON 文件内容
字段 "file_type"（name 必须为 file_type，值为 "json"）
```

**关键约束（来自 ST 源码）：**
- 上传字段名必须是 **`avatar`**——ST 的 multer 中间件配置为 `.single('avatar')`
- 必须传 **`file_type=json`** 参数，否则 ST 无法识别格式返回错误
- JSON 文件内容必须是完整的 SillyTavern V3 格式（含 `spec: chara_card_v3`）
- 成功时返回 `{"file_name":"角色名"}`

#### 第三步四半：手动兜底（API 导入无效时）

如果 API 导入后功能不正常（如额外模型变量解析不可用、世界书不生效等），**在花酿 UI 中手动删除角色后拖拽 JSON 文件导入**。前端导入比 API 导入多一层缓存刷新，能彻底清除 ST 内部残留数据。

操作：用户在 Edge 窗口 → 点开角色 → 点「删除角色」→ 把 JSON 文件拖拽进 ST 窗口。

## 第五步：验证导入

验证导入是否完整，特别是世界书条目是否保留。

**检查方法：** 从 PNG 文件读取角色数据。ST 会将导入的 JSON 转换为 PNG V2 卡片，存储在 `%APPDATA%/hanabrew/st-data/default-user/characters/{角色名}.png`。PNG 的 `chara` 和 `ccv3` tEXt chunk 中 base64 编码了完整的角色 JSON。

解码验证的关键路径：
- `data.character_book`（V3 规范位置）——**不是** `data.extensions.character_book`
- `data.extensions.regex_scripts`——正则脚本
- `data.extensions.tavern_helper`——MVU/Zod 等酒馆助手脚本

### 第六步：前端验证

如果用户在前端操作，需确认以下内容：
- 角色名和开场白是否正确显示
- 角色世界书里的条目是否正常加载
- 状态栏/正则脚本是否生效
- MVU 变量能否正常读取
- 玥光宝盒插件是否有反应

## 已知注意事项

### 世界书位置

tavern-cards-forge 打包时，世界书条目放在 `data.character_book`（V3 规范的标准位置），**不是** `data.extensions.character_book`。ST 的标准 PNG 读写流程会完整保留此字段，无需额外处理。

### 后端 importCharacter 的限制

花酿插件后端的 `importCharacter` 函数（位于 `backend/characters.js`）是简化实现——它只读取 `name`、`description`、`greeting`、`scenario`、`exampleDialogue` 等基础字段，然后调用 `createCharacter` 保存。这意味着：
- 世界书条目 ❌ 丢失
- 正则脚本 ❌ 丢失  
- 脚本（MVU/Zod） ❌ 丢失
- 扩展字段 ❌ 丢失

因此**必须直接通过 ST 的 `/api/characters/import` 接口导入**，才有完整数据。

### PNG 格式问题

无论输入是 JSON 还是 PNG，ST 的 `importFromJson` 始终将角色保存为 PNG V2 格式。即使卡没有头像，ST 也会使用默认头像图片生成一个 PNG 文件。这是 ST 的标准行为，不是问题。

### 用户角色名

花酿的 ST 使用 `{{user}}` 宏来表示用户角色名，与标准 SillyTavern 行为一致。

## 排查指南

| 现象 | 可能原因 | 排查方法 |
|------|----------|----------|
| API 返回 `{"error":true}` | 没传 `file_type` 参数或格式不支持 | 确认传了 `file_type=json` |
| API 返回 400 | 文件字段名不是 `avatar` | multer 配置为 `.single('avatar')` |
| 导入成功但世界书为空 | 用了后端 `importCharacter` 工具函数 | 改用 ST 的 `/api/characters/import` API |
| 改卡后重导入，但变化不生效 | `worlds/` 目录有旧独立世界书 | 删除 `worlds/{角色名}.json` 后再导入 |
| EJS 报错 'xxx is not defined' | 独立世界书残留了旧版 EJS 代码 | 删除 `worlds/{角色名}.json` + 清 `_cache` 后重导 |
| PNG 有数据但 UI 不显示 | 端口变化导致浏览器连到旧端口 | 获取新端口后刷新或重新导航 |
| ST 返回 502 | ST 进程正在启动中 | 等待几秒后重试 |

## 数据存储

花酿的 ST 数据目录：
```
%APPDATA%/hanabrew/st-data/
  default-user/
    characters/         ← 角色卡 PNG + JSON
    chats/              ← 聊天记录
    worlds/             ← 独立世界书（注意：ST 导入角色卡时会自动在此生成同名世界书）
    settings.json       ← 设置
  _cache/               ← 缓存（角色、头像等）
```

**重要**：ST 导入角色卡时会自动在 `worlds/` 目录下生成一个同名独立世界书 JSON 文件。改卡重新导入时如果只替换 `characters/` 里的 PNG，ST 仍然会读取旧的独立世界书，导致修改不生效。因此改世界书条目后，必须同时删除 `worlds/{角色名}.json`。

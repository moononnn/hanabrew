---
name: hanabrew-card-testing
description: "花酿（Hanabrew）测卡配套流程。在花酿中从零创建、打包、导入并测试 SillyTavern 角色卡。MANDATORY TRIGGERS：花酿测卡、角色卡体检、测卡流程、帮我测卡、帮我测一下这张角色卡、试演一下这个角色、看看角色卡变量、hanabrew 测试、花酿配套、写卡后导入花酿、hanabrew import、花酿导入角色。当用户在花酿平台写完角色卡后想要测试，或询问花酿能做什么时触发。也适用于花酿相关的任何角色卡导入、调试、排查问题。"
default-enabled: true
---

# 花酿测卡流程

花酿是 HanaAgent 的社区插件，在 Hana 内部原生运行 SillyTavern 1.18.0。写卡后用本 skill 完成剩余步骤：打包 → 导入花酿 → 验证。

## 用户不需要记住 skill 名称

用户可以在任意 Hana 对话里直接说下面任意一种自然话术：

- 「帮我测一下这张角色卡」
- 「试演一下这个角色」
- 「看看这张卡的变量有没有生效」
- 「验证表白后好感度会不会增加」
- 「帮我调试这个角色卡」

只要表达了测卡意图，就先调用 `tavern-open-theater` 打开「花酿 · 体检」卡片，让用户选择角色卡和测试方向；不要要求用户记住 skill 名称，也不要因为用户没使用“测卡”两个字就漏掉意图。用户问「花酿能做什么」时，要把角色卡体检和直接话术一起介绍出来。

## 小剧场：卡片优先的默认入口

当用户说「帮我测卡」「测一下这个 MVU 变量」「测试某个场景/逻辑」时，先调用 `tavern-open-theater` 打开小剧场卡片。用户在卡片里选择角色卡、固定测卡方式或「代笔对戏」后点击对应按钮，卡片会把请求送回当前对话并切换成过程聊天。

**固定测卡**使用 `tavern-theater-run`：小花根据目标设计 1～12 幕确定性台词，真实酒馆逐幕运行，卡片展示台词、角色回复和变量变化，分析结论回到主对话。

**代笔对戏**是另一条交互链，不要调用固定测卡工具：
1. 收到卡片交接后，先告诉用户已经进入代笔对戏，并等待她给一句大概方向，不要提前生成角色回复或一次写完多轮。
2. 用户给方向后，小花把方向改写成一条自然的第一人称玩家侧消息，调用 `tavern-duet-start` 启动卡片选中的角色并推进第一轮。
3. 读取工具结果里的推进节奏：普通回合按节奏自动连续推进，不要每轮把过程带回主对话等待用户。每次 `tavern-duet-turn` 仍只推进一轮，卡片会逐轮展示；在同一次助手回复里，若还没到暂停点或自动推进安全上限，就继续代写下一条自然的玩家消息并再次调用工具。
4. 节奏含义：`自由发展` 只在重大剧情、不可逆选择或明确边界节点暂停；`慢慢推进` 让普通回合连续发展，在关键剧情、关系变化、越界或重大时间跳跃时暂停；`保持克制` 每轮保留方向控制，出现暧昧、冲突或边界变化前暂停。
5. 只有到暂停点或自动推进安全上限时，才把已经完成的角色回复、变量变化和 `theaterSessionId` 带回主对话，请用户决定下一步。用户给出新的实时方向后，下一次 `tavern-duet-turn` 传 `checkpoint=true` 重置自动推进安全计数；普通续接不传这个字段。`playerMessage` 会原样送进真实角色对话，只能写角色看得到的玩家正文，不能夹带导演说明、测试目的、变量名或隐藏规则。
6. 涉及表白、原谅、关系重大推进、越过边界或重大时间跳跃时，必须先停下来让用户拍板。用户明确说结束、退出或换一场时，调用 `tavern-duet-end` 清理临时聊天。

不要让用户填写技术参数或内部角色 ID。卡片请求里会带选中的角色卡名称；调用工具时传入 `characterName`，或传入卡片明确提供的 `characterId`，不要擅自改测当前活动角色。固定测卡和代笔对戏都必须使用真实 SillyTavern 前端与 `Generate()`，不能用提示词预检冒充真实回复。

小花负责：
1. 卡片提交前不直接开始；用户没有明确选角色和模式时，保持在卡片选择流程。
2. 固定测卡通常设计 3～6 幕，覆盖初始场景、触发条件、变量变化点和反证/边界场景；简单目标可少于 3 幕。
3. 真实测卡期间记录临时测试聊天的开场、逐幕前后变量和变化记录；读不到变量就返回 `null`/不可用，不写成空对象或“没有变化”。
4. 固定测卡结束后在主对话正文回报是否正常、逻辑是否合理、发现的问题和优化建议；卡片只保留过程和完成状态。角色卡有改动时，重新打开卡片再测。

正式入口必须是真实 SillyTavern 运行时。固定测卡使用 `hanabrew-theater-*` 临时聊天；代笔对戏使用 `hanabrew-duet-*` 临时聊天并在结束时清理。正式聊天变量既不读取也不修改，Hana 侧 `mvu-state.json` 也不参与。若 ST、浏览器或模型不可用，工具应报告失败，不能把后端提示词预检冒充真实回复。旧的 `runPromptPreview` 仅用于明确标注的「卡片上下文预检」。

`Mvu` 是酒馆侧 MVU 扩展提供的全局 API，`yue-assistant` 是读取/使用它的扩展，两者职责不同。真实运行时会直接读取当前 ST 页面里的 `Mvu.getMvuData({ type: 'chat' })`；如果变量在当前回合不可用，结果必须标记为不可用，不能把缺失写成 `{}`。

## 效率分工

花酿使用中涉及的操作按效率分配——不是「谁不能做」，而是「谁做更快」：

**小花做更快的事（后端）：**
- 角色卡内容创作
- 调用 tavern-cards-forge 打包
- 通过 ST API 导入角色卡（multipart POST）
- 日志和文件系统检查
- 端口扫描和连通性检测
- 代码级的排查和修复

**你做更快的事（前端）：**
- 在花酿 UI 界面上点按钮、看界面
- 截图反馈渲染效果
- 描述界面上看到的现象

原则：发现需要操作花酿前端界面时（点「世界书」「角色管理」等按钮），小花直接告诉你点哪里、看什么，而不是自己去截图找按钮绕一大圈。你点两下鼠标的事，不值得让小花花几十秒截图分析。

## 前置条件

- 花酿插件（hanabrew）已安装且显示在 Hana 左侧菜单
- tavern-cards 写卡 skill 已完成角色卡内容创作
- 角色卡项目已包含至少一次 `pack` 输出

## 完整流程

### 第一步：确保花酿启动

花酿启动后会在后台启动 SillyTavern 服务器。你点击 Hana 左侧菜单「花酿」即可启动；访问内嵌酒馆时优先使用固定端口 18500，若该端口被占用才回退到随机端口。

### 第二步：获取 SillyTavern 端口

内嵌酒馆优先使用 `http://127.0.0.1:18500/`；如果固定端口被其他程序占用，花酿会自动选择一个空闲端口。需要手动调用 ST API 时，从花酿状态页或日志里的 `st.started` / `st.ready` 记录读取实际端口，不要猜端口。

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

日常导入可以直接调用花酿的 `tavern-import-character` 工具：支持 JSON、YAML 和带角色元数据的 PNG。它会生成新的 PNG 角色卡，保留 `data.character_book`、`data.extensions` 等标准字段；输入为 PNG 时也会保留原头像。导入同目录 PNG 会自动换用新编号，不会覆盖来源卡。

如果要验证 SillyTavern 原生导入、缓存刷新或酒馆专属转换行为，再走 ST 的 `/api/characters/import` 接口。这是另一条导入路径，不能把它的缓存行为和花酿工具混在一起：

```
POST http://127.0.0.1:{端口}/api/characters/import
Content-Type: multipart/form-data

字段 "avatar"（name 必须为 avatar，不是 file）：角色卡 JSON 文件内容
字段 "file_type"（name 必须为 file_type，值为 "json"）
```

**关键约束（来自 ST 源码）：**
- 上传字段名必须是 **`avatar`**——ST 的 multer 中间件配置为 `.single('avatar')`
- 必须传 **`file_type=json`** 参数，否则 ST 无法识别格式返回错误
- JSON 文件内容应是完整的 SillyTavern V3 格式（含 `spec: chara_card_v3`）
- 成功时返回 `{"file_name":"角色名"}`

#### 手动兜底（API 导入后 UI 仍未刷新时）

在完整酒馆里删除旧卡后，再把 JSON/PNG 拖进酒馆窗口，可触发前端自己的缓存刷新。只在 API 导入完成但界面仍显示旧内容时这样做。

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

### 后端 importCharacter 的能力边界

花酿插件后端的 `importCharacter` 函数（位于 `backend/characters.js`）支持 JSON、YAML 和带角色元数据的 PNG：
- 标准角色字段会写入新的 PNG 角色卡
- `data.character_book`、`data.extensions` 等标准字段会保留
- 输入为 PNG 时，原卡头像会一并保留

如果需要验证 SillyTavern 原生导入、缓存刷新或酒馆专属转换行为，仍可直接使用 ST 的 `/api/characters/import` 接口；那是另一条导入路径，不要把两者的缓存行为混在一起。

### PNG 格式问题

无论输入是 JSON 还是 PNG，ST 的 `importFromJson` 始终将角色保存为 PNG V2 格式。即使卡没有头像，ST 也会使用默认头像图片生成一个 PNG 文件。这是 ST 的标准行为，不是问题。

### 用户角色名

花酿的 ST 使用 `{{user}}` 宏来表示用户角色名，与标准 SillyTavern 行为一致。

## 排查指南

| 现象 | 可能原因 | 排查方法 |
|------|----------|----------|
| API 返回 `{"error":true}` | 没传 `file_type` 参数或格式不支持 | 确认传了 `file_type=json` |
| API 返回 400 | 文件字段名不是 `avatar` | multer 配置为 `.single('avatar')` |
| 导入后想确认世界书/扩展是否保留 | 只看角色列表不够 | 解码生成的 PNG，检查 `data.character_book` 与 `data.extensions` |
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

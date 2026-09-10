# 花酿发布契约

这份文件只约束花酿项目的发布，不替代 Hana 插件开发规范。

## 发布类型

- 纯美化、小修复、没有用户流程变化：推送代码并打 Git tag，不创建 Release；`PENDING_CHANGES.md` 继续积累。
- 新功能、用户正在等待的修复、交互流程变化：走完整发布流程，创建带安装包的 GitHub Release。
- 拿不准档位时，先停在本地，不擅自创建 Release。

## 发布工作区

本地正式目录（`<HANA_HOME>/plugins/hanabrew`）只管开发，公开内容从独立克隆推送：

- 发布仓库克隆：`L:\哈娜的工作台\hanabrew`（remote 指向 `moononnn/hanabrew`）
- 同步脚本：`L:\哈娜的工作台\花酿发布\sync-release.mjs`（清空克隆目录后按规则复制，并加工 manifest 去掉 chat 卡片）

同步脚本排除的内容：轻聊卡片（`routes/card.js`、`tools/tavern-chat.js`、`tools/tavern-open-card.js`、`tests/chat-card.test.js`）、运行时产物、本地开发文档、内置第三方扩展的开发文件与 source map。

公开版必须能独立跑通测试：`tests/` 里的测试会直接加载 `sillytavern/src/` 下的模块（例如 `character-card-parser.js`、`png/encode.js`），所以根 `package.json` 要声明这些 ST 模块用到的 npm 包（当前：`crc`、`png-chunks-extract`、`png-chunk-text`）。以后新增对 ST 模块的测试引用时，同步维护这份依赖。

推送前验证顺序：同步 → 在克隆目录 `npm ci` → `npm test` 全绿 → push → 等 CI 全绿。

## 本版公开范围

本地正式目录继续保留「轻聊」的代码和入口，供后续继续试用；本次公开版不包含这项功能。打包和公开同步时必须排除轻聊卡片、轻聊工具及其测试，并从公开版 manifest 中移除 `chat` 卡片贡献，同时把 description 里的「轻聊卡片」描述一并去掉（本地版保留该词，因为它描述的是本机真实形态）；不要为了做发布副本而删除正式目录里的本地实现。

## 版本与账本

- `manifest.json`、`package.json` 和 `package-lock.json` 的版本必须一致。
- 每个已完成且测试通过的功能或修复，都在 `PENDING_CHANGES.md` 记一笔，并按项目版本规则递增版本；半成品不升版本。
- 完整发布前，把账本内容整理进 `CHANGELOG.md`，确认没有遗漏后再清空账本（保留文件头）。
- Release 标题必须包含版本号和主要内容，例如：`v1.2.0 — 角色来访与角色卡兼容修复`。

## 固定顺序

1. 读取本文件、`TESTING.md` 和插件开发规范。
2. 完成代码、文档和测试；运行 `npm test`，并对发布范围内的 JavaScript 运行 `node --check`。
3. 对源码做外传红线扫描：个人姓名、其他助手姓名、真实邮箱、凭据、测试入口和本机私密路径都不能进入发布内容；对外署名统一为 `moononnn & 小花`。
4. 只把逻辑边界清楚的改动拆成独立提交；禁止使用 `git add .`，逐项确认发布文件。
5. 推送到 `https://github.com/moononnn/hanabrew.git`。
6. 等 GitHub CI 全部通过；CI 失败先修复，不打包、不建 Release。
7. 在工作台建立干净发布暂存目录，做包内容审查和全新安装模拟。
8. 从干净暂存目录打包，计算 SHA-256。
9. 由小花创建 GitHub Release，标题写版本号加主要内容，附上 zip 和 SHA-256；完成后提醒确认。

未经明确确认，不执行第 5 步，也不创建外部可见的 Release。当前仓库历史仍需单独核对提交身份；若要重写历史，必须另行确认，不能为了发版擅自执行破坏性重写。

## 干净安装包范围

安装包只放插件本体和运行所需的源码：

- `manifest.json`、`package.json`、`package-lock.json`、`index.js`
- `backend/`、`lib/`、`routes/`、`tools/`、`assets/`
- `skills/`
- `sillytavern/` 源码、`package.json`、`package-lock.json`、默认模板和许可证文件
- `README.md`、`LICENSE`

明确排除：

- `node_modules/`、日志、临时文件、`*.tmp`
- `sillytavern/data/`、`sillytavern/backups/`、`sillytavern/sillytavern/`
- `st-original-package.json`、测试文件、项目工作日志和 `PENDING_CHANGES.md`
- `docs/`（README 截图，只在 GitHub 仓库展示，不进安装包）
- `backend/agent-gateway*.js` 等实验性 Agent Gateway 文件
- `data.json`、`preferences.json`、运行时 state、secrets、缓存和任何用户内容

测试文件联动规则：安装包排除了 `tests/` 与 `TESTING.md` 时，`package.json` 的 `npm test` 脚本必须同步处理，不能留成「空跑 0 测试还成功退出」的假绿灯（`node --test tests/*.test.js` 在无匹配文件时 tests 0 / pass 0 / fail 0 且 exit 0，会骗过自动审查）。修法二选一：① 把 test script 改成显式断言测试文件存在的哨兵（test count > 0，否则非零退出）；② 移除 test script 并在 README 开发章节注明「测试只在源码仓库执行」。README 里对 `TESTING.md` 的引用也要和包内容一致。

依赖不随主插件包携带。若另行制作依赖包，必须单独命名并明确说明它只能解压到 `sillytavern/node_modules/`，不能当插件安装。

## 交叉审查门

对最终 zip 实物做三层检查：

### A：包内容

- 文件清单没有用户数据、备份、日志、`node_modules` 和实验 Gateway。
- `manifest.json` 的入口、卡片和版本可解析；所有路径存在。
- 干净副本 `node --check` 与 `npm test` 通过。
- 版本、账本、README、CHANGELOG 和 Release 标题对得上。

### B：安装模拟

- 在全新目录解压，能识别插件入口和 skill。
- 确认首次访问会自动安装依赖，依赖缺失和失败重试页面可用。
- 用旧版 `st-data` 做升级模拟，角色、聊天、世界书和来访状态不被误删。
- 确认运行数据写入 `%APPDATA%\\hanabrew\\`，不回写安装包源码目录。

### C：外传红线

- 全库扫描不出现个人姓名、其他助手姓名、真实邮箱、凭据或本机私密路径。
- 本地测试按钮和测试入口不会进入发布副本。
- README 的风险、Node.js 版本、依赖下载、模型请求和数据位置与代码一致。
- GitHub CI 已通过，发布包 SHA-256 已记录。

## 署名与隐私

对外文案、README、CHANGELOG、Release notes、代码注释和提交信息不得写入个人姓名、其他助手姓名或真实邮箱。项目署名只使用：

```text
moononnn & 小花
```

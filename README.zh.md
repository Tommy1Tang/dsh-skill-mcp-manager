# dsh-skill-mcp-manager

一个面板管两件事：**本地 skill** 和 **MCP 服务器**。安装、启用、禁用、删除都在同一处。

## 装了什么

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | [`lib/index.js`](lib/index.js) | 在 `ctx.webServer` 上注册 `/skill-mcp-manager` 路由；所有落盘操作只在这里发生 |
| Client | [`client.js`](client.js) | 侧栏底部按钮 + 覆盖式对话框：技能 / MCP 两个标签页 |
| Bundle | [`cordis.patch.yml`](cordis.patch.yml) | 只插入一行 Host 插件 |

## 怎么打开

刷新 Web 页面 → 左栏底部、设置按钮旁边多一个「技能 / MCP 管理器」图标 → 点开即是面板。ESC 或点遮罩关闭。

## 四个操作分别落到哪

**skill**（扫描根 = 项目根、`customSkillDirs`、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills`，按 provider 的优先级排列）

项目根指 `<project>/.dsh/skills` 与 `<project>/.agents/skills`。Host 插件自己没有 cwd，所以不猜 `process.cwd()`：目录来自两处 —— 配置里的 `projectRoots`，以及 GUI 已经在维护的**工作区注册表**（`ctx.workspaceRegistry`）。注册表可能登记几十个项目，每个贡献两个根，所以自动探测只取最近 12 个（`projectRoots` 里显式写的不受限）；不存在的项目根不会出现在「安装地址」按钮里，但只要你手工指定路径，`scanned` 判定仍然认它。项目内的 skill 行会带一个灰色「项目」徽标 —— 它只在该项目目录下启动的会话里可见。

| 操作 | 实际动作 |
|---|---|
| 安装 | 在「安装地址」那个目录下写 `<name>/SKILL.md`（name 必须 kebab-case，description 必填）；也可以填绝对路径，把已有目录/文件整体导入 |
| 禁用 | 把条目移进同根的 `.disabled/`（该目录不在发现深度内，skill 立刻从目录消失） |
| 启用 | 从 `.disabled/` 移回根目录 |
| 删除 | 删除磁盘上的目录/文件；不在扫描根里的条目用「按路径删除」（仍然只允许删已知根内的路径，见下） |

### 拖入安装（文件夹 / SKILL.md / zip）

面板「安装」区最上面是一个虚线投放框，三种东西都能直接扔进去：

| 拖入内容 | 处理方式 |
|---|---|
| `<name>/` 文件夹（含 `SKILL.md`） | 浏览器递归读取（`webkitGetAsEntry`），保留 `references/`、`scripts/`、`assets/` 等全部文件，文本按文本传、二进制按 base64 传 |
| 单个 `SKILL.md` | 直接作为 bundle 根，缺 `name`/`description` 时自动补齐 |
| `<name>.zip`（或 GitHub 下载的 `repo-main.zip`） | 上传后由 Host 用内置 zip 解析器解包（中央目录 + `inflateRawSync`，无第三方依赖），自动剥掉外层包装目录 |

规则与边界：

- 包里必须有 `SKILL.md`；`SKILL.md` 必须在（剥壳后的）根目录，否则报错并指出实际位置。
- 目录名取 `name` → frontmatter 的 `name` → 外层目录名，统一 slug 成 kebab-case。
- 缺 `description` 会补一句占位描述并给出 warning（否则 provider 会静默丢弃该 skill），请事后改成真实描述。
- 拒绝 `..`、绝对路径、盘符路径；`.git/`、`__MACOSX/`、`.DS_Store`、`Thumbs.db` 直接忽略。
- 上限：单次 12 MB / 400 个文件；zip64 不支持。请求体上限按 base64 反推为 17 MB，超过返回 `请求体过大（上限 17 MB）`——导入上限和 body 上限必须一起动，否则 12 MB 就是摆设。
- 带 BOM 的 `SKILL.md`（记事本、PowerShell 5.1 会写）按正常文件处理：读入先剥 BOM，不会误报「缺 name/description」，也不会写出双份 frontmatter。
- 目标已存在时要显式覆盖（面板走同一接口时由后端拒绝并回传原因）。
- 删除护栏：`按路径删除` 只接受落在已知 skill 根（两个默认根、`customSkillDirs`、`extraRoots`、`installRoot`）内的路径；根目录本身与根下的 `.disabled/` 本身直接拒绝。
- 也可以不经拖放：虚线框里的「选择文件夹」「选择文件 / zip」按钮走同一套逻辑。

### 操作反馈

每次点击都有三层回应，不用猜：

| 位置 | 内容 |
|---|---|
| 按钮本身 | `安装中…` → `✓ 安装成功` / `✗ 安装失败`，4 秒后回到常态 |
| 按钮左侧的状态行 | `✓ 已安装 my-skill → D:\dsh\skills\my-skill`；失败显示服务端原话（`✗ 非法路径（含 ..）: ../evil.md`） |
| 对话框右上角 toast | 所有操作共用：成功绿勾、失败红叉加原因，6 秒自动消失，可手动关闭 |

拖放导入同样如此（`已导入 xxx（N 个文件）→ 路径`），MCP 的添加/启停/删除也都有 toast。`description` 缺失这类 warning 仍旧停在黄色提示条里，因为它需要你事后改文件，不该跟着 toast 消失。

### 「启用中」不等于模型看得见

发现与否由 `dsh-skill-filesystem` 决定，它有三条硬规则：frontmatter 必须有 `name` 与 `description`，`disable-model-invocation: true` 的条目不会进入模型目录。面板解析这三项，命中任一条就在该行打黄色「模型不可见」徽标，并在下面写出原因（例：`disable-model-invocation: true`）。`user-invocable: false` 只影响用户侧入口，单独记录、不触发徽标。

现成例子：`grill-me` 就是 `disable-model-invocation: true` —— 面板里在，模型目录里没有。

### 把 skill / MCP 放到 D 盘

**skill：为什么不能只改扫描根。** web 组合里全局 `skill-filesystem` 行是 `disabled` 的（见 `packages/bundle/web-app/cordis.patch.yml`），实际发现由 **agent preset** 各自挂载自己的 `skill-filesystem`，profile patch 里给全局行写 `customSkillDirs` 不会生效。所以磁盘位置用目录联接（junction）解决——路径不变，数据在 D 盘：

```powershell
# 一次性：把用户 skill 根指到 D 盘
Move-Item -LiteralPath "$env:USERPROFILE\.agents\skills\*" -Destination 'D:\dsh\skills' -Force
Remove-Item -LiteralPath "$env:USERPROFILE\.agents\skills" -Force
New-Item -ItemType Junction -Path "$env:USERPROFILE\.agents\skills" -Target 'D:\dsh\skills'
```

junction 对 Node 完全透明：provider 照常 `readdir`、chokidar 照常监视，模型拿到的名字与正文不变，只是字节落在 D 盘。删除联接不影响 D 盘内容：`Remove-Item <junction>` 只删链接。

同一件事也写成了脚本（幂等，重复运行只报告状态）：

```powershell
.\scripts\relocate-to-d.ps1                       # 默认 C:\Users\<you>\.agents\skills -> D:\dsh\skills
.\scripts\relocate-to-d.ps1 -Target 'E:\dsh\skills'
```

**skill：默认装到 D 盘。** 面板「安装地址」预填 `installRoot`：

```yaml
- id: skill-mcp-manager
  config:
    installRoot: 'D:\dsh\skills'
    mcpRoot: 'D:\dsh\mcp'
    extraRoots: []          # 可选：更多快捷选择目录
    projectRoots: []        # 可选：显式补充项目根，如 ['D:\AI_RPG_engine']
```

单次覆盖：安装表单里的「安装地址」；不在扫描根里的目录会标黄并说明「文件写进去了但不会被加载」。

**MCP：没有"安装目录"，只有工作目录与缓存。** stdio 服务器是一条被 spawn 的命令，所以"装到 D 盘"= 给它一个 D 盘上的 `cwd`，并把 npm/pnpm 的缓存指到 D 盘。管理器在 `add` 时自动做这三件事：

```yaml
- id: mcp-demo-local
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: 'demo-local'
    transport: 'stdio'
    command: '…\node.exe'
    args: ['server.mjs']
    cwd: 'D:\dsh\mcp\demo-local'          # 自动：<mcpRoot>/<serverName>
    env:
      npm_config_cache: 'D:\dsh\mcp\.npm-cache'        # 自动
      npm_config_store_dir: 'D:\dsh\mcp\.pnpm-store'   # 自动
```

`<mcpRoot>` 由 `mcpRoot` 配置决定，缺省 `$DSH_HOME/mcp`。自己给 `cwd`/`env` 的，管理器不覆盖。

仓库里带了一个零依赖示例服务器 [`examples/demo-local/server.mjs`](examples/demo-local/server.mjs)（`ping` / `where` 两个工具，`where` 返回自己的工作目录）。运行时副本放在 `D:\dsh\mcp\demo-local\server.mjs`，已作为 `demo-local` 注册在面板里，可直接验证「进程在 D 盘、DSH 正常调用」。

**MCP**（状态存在 `<profile>/skill-mcp-manager/state.json`，旧版 `$DSH_HOME/skill-mcp-manager/state.json` 只读兜底）

| 操作 | 实际动作 |
|---|---|
| 安装 | 往 profile 的 `cordis.patch.yml` 里重写受管段落，插一行 `@deepseek-ai/dsh-mcp-client` |
| 编辑 | 面板行上的「编辑」把该服务器灌回表单，保存时走 `update`：重写同一行，名字锁死（改名＝删掉重建） |
| 禁用 | 从受管段落里移除该行 |
| 启用 | 重新写入该行 |
| 删除 | 从状态里删掉并重写段落；服务器清零时整段移除，patch 文件恢复原样 |

受管段落以 `# >>> dsh-skill-mcp-manager (managed)` 开头、`# <<< dsh-skill-mcp-manager` 结尾，段落外的一切（注释、手写行）原样保留。

## 接口

Host 半边只认 JSON，面板是唯一调用方；也可以直接拿 curl 操作。

```
GET  /skill-mcp-manager/state
POST /skill-mcp-manager/action
```

```jsonc
// 安装 skill
{ "domain": "skill", "op": "install", "name": "my-skill", "description": "什么时候用它", "body": "# 步骤…" }
// 换目录安装（root 会覆盖 installRoot 配置）
{ "domain": "skill", "op": "install", "name": "my-skill", "description": "…", "root": "D:\\skills" }
// 导入已有目录
{ "domain": "skill", "op": "install", "from": "D:\\skills\\my-skill" }
// 拖入：zip（base64）
{ "domain": "skill", "op": "import", "zip": "<base64>", "overwrite": false }
// 拖入：文件夹清单（文本走 text，二进制走 base64）
{ "domain": "skill", "op": "import", "files": [
    { "path": "my-skill/SKILL.md", "text": "---\nname: my-skill\n..." },
    { "path": "my-skill/assets/logo.png", "base64": "<base64>" }
  ] }
// 禁用 / 启用 / 删除
{ "domain": "skill", "op": "disable", "name": "my-skill" }
{ "domain": "skill", "op": "enable",  "name": "my-skill" }
{ "domain": "skill", "op": "delete",  "name": "my-skill" }
{ "domain": "skill", "op": "delete",  "path": "D:\\skills\\my-skill" }

// 安装 MCP 服务器
{ "domain": "mcp", "op": "add", "serverName": "github", "transport": "stdio",
  "command": "npx", "args": "-y\n@modelcontextprotocol/server-github", "env": "GITHUB_TOKEN=xxx" }
{ "domain": "mcp", "op": "add", "serverName": "remote", "transport": "streamable-http",
  "url": "http://127.0.0.1:3000/mcp", "headers": "Authorization=Bearer xxx" }
// 编辑（serverName 是定位键，不能在这条请求里改名；远端服务器可改 url / headers）
{ "domain": "mcp", "op": "update", "serverName": "remote", "transport": "streamable-http",
  "url": "http://127.0.0.1:3000/mcp", "headers": "Authorization=Bearer yyy" }
// 开关 / 删除
{ "domain": "mcp", "op": "disable", "serverName": "github" }
{ "domain": "mcp", "op": "enable",  "serverName": "github" }
{ "domain": "mcp", "op": "delete",  "serverName": "github" }
```

失败一律 `400` + `{ "ok": false, "error": "原因" }`，成功返回 `{ "ok": true, "result": …, …最新快照 }`。快照里的 `mcp.consistent` 与 `mcp.blockServers` 用来提示「state 期望的服务器」和「patch 段落里真实存在的服务器」是否一致，面板据此在顶部标黄；`mcp.statePath` 告诉你当前 profile 的状态文件落在哪。

## 设计取舍

- **禁用 skill 靠搬目录，不靠注册表。** `ctx.skills` 只有 `register / list / get / invalidate`，没有「禁用某个 skill」的概念；把条目移出发现深度（方案：同根 `.disabled/`）是唯一不引入新格式、且对 watcher 立即生效的做法。
- **MCP 行只归本管理器所有。** profile patch 里其它条目一律不动，重写范围严格限制在受管段落内；段落清空后整段删除，不留空标记。
- **profile 目录靠自证定位。** `DSH_PROFILE_DIR` 只存在于 shell 环境；拿不到时依次尝试 `profileContext`、再按「哪个 profile 的 `node_modules/dsh-skill-mcp-manager` 指向本包」反查，所以不需要用户填路径。
- **面板不 import 任何 Harness Client 包。** 只用 `require('react')` 与 `--dsw-alias-*` 主题令牌，避免版本升级把面板打空。
- **删除要有边界。** 按路径删除是唯一能删到扫描根外的口子，也最容易一误删全库；所以校验放在 Host：路径必须落在已知根内，根本身与 `.disabled/` 本身直接拒绝。前端只负责二次确认，不承担判断。
- **写操作串行，读的时候对账。** state 与 patch 是两份文件，读-改-写不能并发，路由层用一条 promise 链把动作排队；读快照时顺手解析段落里的 `serverName` 与 state 比对，不一致就报出来，而不是假装没事。
- **项目根不猜 cwd。** provider 按每个 agent 的 cwd 扫 `<project>/.dsh/skills` 与 `<project>/.agents/skills`，Host 插件没有 cwd；用 `process.cwd()` 猜会把无关目录标成「扫描根」。所以只认两个来源：配置里的 `projectRoots` 和 `ctx.workspaceRegistry` 里登记的项目，且自动探测封顶 12 个（每个项目两个根）。
- **state 跟着 profile 走。** 受管段落写进哪个 profile，服务器清单就该住在哪个 profile；共用 `$DSH_HOME` 一份文件时，两个 profile 会互相覆盖。旧文件保留为只读兜底，首个写操作之后自然迁移到 profile 下。

## 测试

```powershell
npm test     # node --test，32 个用例，零第三方依赖
```

- `test/units.test.mjs`：直接打 `lib/index.js` 暴露的 `__test__` 纯函数 —— BOM 剥离、frontmatter 解析/补齐、条目路径规范化、zip 解析（store + deflate）、外层剥壳、删除护栏、根序与项目根、受管段落解析。
- `test/http.test.mjs`：假 `webServer` 收路由 + 真 `node:http` 发请求，走完整接口 —— 导入（含 BOM 包与 >256 KB 的包）、body 上限、删除护栏、skill 启停、项目根扫描与「项目」标记、MCP 增删启停与 `update`（含 headers 渲染）、patch 外来行保留、state/patch 漂移检测、按 profile 隔离的 state。
- `test-support/zip.mjs`：自带的极简 zip 写入器，用来造夹具，不参与测试发现。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-skill-mcp-manager
```

或直接删掉 profile `package.json` 里的 `dsh-skill-mcp-manager` 依赖与 `dsh.profile.bundles` 条目，以及 patch 里的受管段落。

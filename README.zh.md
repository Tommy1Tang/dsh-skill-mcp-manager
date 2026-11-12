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

**skill**（扫描根 = `$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills`，外加配置里的 `customSkillDirs`）

| 操作 | 实际动作 |
|---|---|
| 安装 | 在「安装地址」那个目录下写 `<name>/SKILL.md`（name 必须 kebab-case，description 必填）；也可以填绝对路径，把已有目录/文件整体导入 |
| 禁用 | 把条目移进同根的 `.disabled/`（该目录不在发现深度内，skill 立刻从目录消失） |
| 启用 | 从 `.disabled/` 移回根目录 |
| 删除 | 删除磁盘上的目录/文件；不在扫描根里的条目用「按路径删除」 |

### 把 skill / MCP 放到 D 盘

**skill：为什么不能只改扫描根。** web 组合里全局 `skill-filesystem` 行是 `disabled` 的（见 `packages/bundle/web-app/cordis.patch.yml`），实际发现由 **agent preset** 各自挂载自己的 `skill-filesystem`，profile patch 里给全局行写 `customSkillDirs` 不会生效。所以磁盘位置用目录联接（junction）解决——路径不变，数据在 D 盘：

```powershell
# 一次性：把用户 skill 根指到 D 盘
Move-Item -LiteralPath "$env:USERPROFILE\.agents\skills\*" -Destination 'D:\dsh\skills' -Force
Remove-Item -LiteralPath "$env:USERPROFILE\.agents\skills" -Force
New-Item -ItemType Junction -Path "$env:USERPROFILE\.agents\skills" -Target 'D:\dsh\skills'
```

junction 对 Node 完全透明：provider 照常 `readdir`、chokidar 照常监视，模型拿到的名字与正文不变，只是字节落在 D 盘。删除联接不影响 D 盘内容：`Remove-Item <junction>` 只删链接。

**skill：默认装到 D 盘。** 面板「安装地址」预填 `installRoot`：

```yaml
- id: skill-mcp-manager
  config:
    installRoot: 'D:\dsh\skills'
    mcpRoot: 'D:\dsh\mcp'
    extraRoots: []          # 可选：更多快捷选择目录
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

**MCP**（状态存在 `$DSH_HOME/skill-mcp-manager/state.json`）

| 操作 | 实际动作 |
|---|---|
| 安装 | 往 profile 的 `cordis.patch.yml` 里重写受管段落，插一行 `@deepseek-ai/dsh-mcp-client` |
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
// 开关 / 删除
{ "domain": "mcp", "op": "disable", "serverName": "github" }
{ "domain": "mcp", "op": "enable",  "serverName": "github" }
{ "domain": "mcp", "op": "delete",  "serverName": "github" }
```

失败一律 `400` + `{ "ok": false, "error": "原因" }`，成功返回 `{ "ok": true, "result": …, …最新快照 }`。

## 设计取舍

- **禁用 skill 靠搬目录，不靠注册表。** `ctx.skills` 只有 `register / list / get / invalidate`，没有「禁用某个 skill」的概念；把条目移出发现深度（方案：同根 `.disabled/`）是唯一不引入新格式、且对 watcher 立即生效的做法。
- **MCP 行只归本管理器所有。** profile patch 里其它条目一律不动，重写范围严格限制在受管段落内；段落清空后整段删除，不留空标记。
- **profile 目录靠自证定位。** `DSH_PROFILE_DIR` 只存在于 shell 环境；拿不到时依次尝试 `profileContext`、再按「哪个 profile 的 `node_modules/dsh-skill-mcp-manager` 指向本包」反查，所以不需要用户填路径。
- **面板不 import 任何 Harness Client 包。** 只用 `require('react')` 与 `--dsw-alias-*` 主题令牌，避免版本升级把面板打空。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-skill-mcp-manager
```

或直接删掉 profile `package.json` 里的 `dsh-skill-mcp-manager` 依赖与 `dsh.profile.bundles` 条目，以及 patch 里的受管段落。

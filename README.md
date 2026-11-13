# dsh-skill-mcp-manager

A panel inside **DeepSeek Harness (DSH)** that manages local skills and MCP servers in one place: search, inspect, install, enable/disable, batch operations, undoable deletion, and an honest connection status.

> 中文文档：[README.zh.md](README.zh.md)

## What it does

| Area | Capability |
|---|---|
| Skills | List skills from every scanned root (project, custom, user), search and filter them, inspect body/files/references |
| Install | Write a new `SKILL.md`, import an existing directory, or drop a folder / `SKILL.md` / `.zip` onto the panel |
| Lifecycle | Enable/disable by moving entries into `<root>/.disabled/`, batch enable/disable/delete |
| Policy | Toggle `disable-model-invocation` (the flag that hides a skill from the model while keeping it user-invocable) |
| Delete | Moves the entry into `<root>/.trash/` with a record of its original path; restore or purge from the panel |
| MCP | Add/edit/remove servers, write them into the profile's managed `cordis.patch.yml` block, show live connection state and tool list |
| Secrets | Render env/header values as `!!js process.env.NAME` so tokens stay in the environment instead of the patch file |
| Safety | Managed block is validated, backed up (`.bak`) and read back after every write; cross-site writes are rejected |

## How it fits DSH

- The **Host half** (`lib/index.js`) registers `/skill-mcp-manager` routes on `ctx.webServer` and performs every filesystem mutation.
- The **Client half** (`client.js`) adds a sidebar-footer button and an overlay dialog; it only talks to those routes.
- The **bundle** (`cordis.patch.yml`) inserts one Host row, so adding the package to a profile's `dsh.profile.bundles` is enough.

## Requirements

- DSH with the web bundle (`@deepseek-ai/dsh-web-app`)
- Node.js >= 18

## Install into a DSH profile

Add the package to the profile and its bundle list, then restart DSH:

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-skill-mcp-manager": "link:D:/path/to/dsh-skill-mcp-manager"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-skill-mcp-manager"
      ]
    }
  }
}
```

Open the Web GUI, refresh, and click the **技能 / MCP 管理器** button at the bottom of the sidebar.

## Configuration

```yaml
# <profile>/cordis.patch.yml
- id: skill-mcp-manager
  config:
    installRoot: 'D:\dsh\skills'   # default install target
    mcpRoot: 'D:\dsh\mcp'          # working dir + package cache for stdio servers
    extraRoots: []                 # more quick-pick install directories
    projectRoots: []               # explicit project roots (otherwise taken from ctx.workspaceRegistry)
```

## HTTP API

```
GET  /skill-mcp-manager/state
POST /skill-mcp-manager/action
```

`op` values: `install`, `import`, `enable`, `disable`, `delete`, `restore`, `purge`, `policy`, `detail`, `batch` for `domain: "skill"`; `add`, `update`, `enable`, `disable`, `delete`, `batch` for `domain: "mcp"`. Failures answer `400` (cross-site or non-JSON writes answer `403`) with `{ "ok": false, "error": "reason" }`.

## Tests

```powershell
npm test    # node --test, 45 cases, no third-party dependencies
```

## License

MIT

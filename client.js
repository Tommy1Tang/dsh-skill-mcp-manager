/**
 * dsh-skill-mcp-manager — browser half.
 *
 * A single panel (sidebar foot action + overlay dialog) that lists local skills
 * and MCP servers and does the four operations that matter: install, enable,
 * disable, delete. Every mutation goes through the Host half's
 * `/skill-mcp-manager` routes; this file keeps no state of its own beyond the
 * last snapshot it fetched.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-mcp-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const MOUNT = '/skill-mcp-manager'
    const TITLE = '技能 / MCP 管理器'

    /* ---------------------------------------------------------- open state */

    let open = false
    const openListeners = new Set()
    function setOpen(next) {
      open = next
      for (const listener of openListeners) {
        try {
          listener()
        } catch {
          /* ignore */
        }
      }
    }
    function useOpen() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force(value => value + 1)
        openListeners.add(listener)
        return () => openListeners.delete(listener)
      }, [])
      return [open, setOpen]
    }

    /* --------------------------------------------------------------- fetch */

    function endpoint(path) {
      try {
        return new URL(MOUNT + path, window.location.origin).toString()
      } catch {
        return MOUNT + path
      }
    }

    async function request(path, init) {
      const response = await fetch(endpoint(path), {
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...(init && init.headers) },
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || (payload && payload.ok === false)) {
        const reason = payload && payload.error ? payload.error : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return payload || {}
    }

    /* -------------------------------------------------------------- styles */

    const colors = {
      base: 'var(--dsw-alias-bg-base, Canvas)',
      layer1: 'var(--dsw-alias-bg-layer-1, Canvas)',
      layer2: 'var(--dsw-alias-bg-layer-2, ButtonFace)',
      overlay: 'var(--dsw-alias-bg-overlay, rgba(0,0,0,0.45))',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      muted: 'var(--dsw-alias-label-secondary, GrayText)',
      brand: 'var(--dsw-alias-brand-primary, Highlight)',
      danger: 'var(--dsw-alias-state-error-primary, #d14343)',
      success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      warn: 'var(--dsw-alias-state-warn-primary, #d98324)',
      idle: 'var(--dsw-alias-state-idle-primary, GrayText)',
    }

    const s = {
      backdrop: {
        position: 'fixed',
        inset: '0px',
        zIndex: 2147482000,
        background: colors.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        font: '13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
        color: colors.text,
      },
      card: {
        width: 'min(920px, 100%)',
        maxHeight: 'min(84vh, 780px)',
        display: 'flex',
        flexDirection: 'column',
        background: colors.layer1,
        color: colors.text,
        border: `1px solid ${colors.borderStrong}`,
        borderRadius: '14px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 18px',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.layer2,
      },
      title: { fontSize: '14px', fontWeight: 600, margin: 0 },
      tabs: { display: 'flex', gap: '4px', marginLeft: '12px' },
      tab: active => ({
        padding: '5px 12px',
        borderRadius: '999px',
        border: `1px solid ${active ? colors.brand : 'transparent'}`,
        background: active ? colors.layer1 : 'transparent',
        color: active ? colors.text : colors.muted,
        cursor: 'pointer',
        font: 'inherit',
      }),
      body: { padding: '14px 18px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' },
      sectionTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        fontWeight: 600,
        color: colors.muted,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        margin: 0,
      },
      count: {
        padding: '0 6px',
        borderRadius: '999px',
        background: colors.layer2,
        border: `1px solid ${colors.border}`,
        color: colors.muted,
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: 0,
        textTransform: 'none',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '10px 12px',
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        background: colors.base,
      },
      rowMain: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      rowName: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13px' },
      rowDesc: {
        color: colors.muted,
        fontSize: '12px',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      rowPath: {
        color: colors.idle,
        fontSize: '11px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        textAlign: 'left',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' },
      button: (kind, disabled) => {
        const palette = {
          ghost: { background: 'transparent', color: colors.text, border: colors.border },
          primary: { background: colors.brand, color: '#fff', border: colors.brand },
          danger: { background: 'transparent', color: colors.danger, border: colors.border },
        }[kind || 'ghost']
        return {
          padding: '4px 10px',
          borderRadius: '7px',
          border: `1px solid ${palette.border}`,
          background: palette.background,
          color: palette.color,
          cursor: disabled ? 'progress' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          font: 'inherit',
          fontSize: '12px',
          whiteSpace: 'nowrap',
        }
      },
      form: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '8px',
        padding: '12px',
        border: `1px dashed ${colors.borderStrong}`,
        borderRadius: '10px',
        background: colors.base,
      },
      field: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
      label: { fontSize: '11px', color: colors.muted },
      input: {
        padding: '5px 8px',
        borderRadius: '7px',
        border: `1px solid ${colors.border}`,
        background: colors.layer1,
        color: colors.text,
        font: 'inherit',
        fontSize: '12px',
        minWidth: 0,
      },
      textarea: {
        padding: '5px 8px',
        borderRadius: '7px',
        border: `1px solid ${colors.border}`,
        background: colors.layer1,
        color: colors.text,
        font: '12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
        minHeight: '58px',
        resize: 'vertical',
      },
      wide: { gridColumn: '1 / -1' },
      banner: kind => ({
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '12px',
        border: `1px solid ${kind === 'error' ? colors.danger : colors.border}`,
        color: kind === 'error' ? colors.danger : colors.muted,
        background: colors.base,
      }),
      pill: kind => ({
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: `1px solid ${kind === 'on' ? colors.success : colors.idle}`,
        color: kind === 'on' ? colors.success : colors.muted,
        fontWeight: 500,
      }),
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 18px',
        borderTop: `1px solid ${colors.border}`,
        color: colors.muted,
        fontSize: '11px',
      },
      icon24: {
        width: '24px',
        height: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '7px',
        border: `1px solid ${colors.border}`,
        background: 'transparent',
        color: colors.text,
        cursor: 'pointer',
        padding: 0,
      },
    }

    function Button({ children, onClick, kind, busy, title }) {
      return h(
        'button',
        { type: 'button', title, onClick, disabled: Boolean(busy), style: s.button(kind, busy) },
        busy ? '…' : children,
      )
    }

    /* ------------------------------------------------------------- controls */

    function Field({ label, wide, children }) {
      return h('label', { style: wide ? { ...s.field, ...s.wide } : s.field }, h('span', { style: s.label }, label), children)
    }

    function TextInput({ style, ...props }) {
      return h('input', { ...props, style: { ...s.input, ...(style || {}) } })
    }

    /* --------------------------------------------------------------- skills */

    function SkillRow({ skill, busy, onToggle, onDelete }) {
      const [confirming, setConfirming] = useState(false)
      useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), 4000)
        return () => clearTimeout(timer)
      }, [confirming])
      return h(
        'div',
        { style: s.row },
        h(
          'div',
          { style: s.rowMain },
          h(
            'div',
            { style: s.rowName },
            skill.name,
            h('span', { style: s.pill(skill.disabled ? 'off' : 'on') }, skill.disabled ? '已禁用' : '启用中'),
          ),
          skill.description ? h('div', { style: s.rowDesc }, skill.description) : null,
          h('div', { style: s.rowPath, title: skill.path }, skill.path),
          skill.realPath && skill.realPath !== skill.path
            ? h('div', { style: s.rowPath, title: skill.realPath }, `→ ${skill.realPath}`)
            : null,
        ),
        h(
          'div',
          { style: s.actions },
          h(
            Button,
            { kind: skill.disabled ? 'primary' : 'ghost', busy, onClick: () => onToggle(skill, skill.disabled) },
            skill.disabled ? '启用' : '禁用',
          ),
          h(
            Button,
            {
              kind: 'danger',
              busy,
              onClick: () => {
                if (!confirming) {
                  setConfirming(true)
                  return
                }
                onDelete(skill)
              },
              title: '删除会移除磁盘上的 skill 目录',
            },
            confirming ? '确认删除' : '删除',
          ),
        ),
      )
    }

    function InstallSkill({ busy, snapshot, onInstall }) {
      const targets = (snapshot && snapshot.installTargets) || []
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [body, setBody] = useState('')
      const [from, setFrom] = useState('')
      const [root, setRoot] = useState((snapshot && snapshot.installRoot) || '')
      const scanned = targets.some(target => target.dir === root && target.scanned)
      const submit = () => {
        const payload = { root: root.trim() || undefined }
        if (from.trim()) return onInstall({ ...payload, op: 'install', from: from.trim(), name: name.trim() || undefined })
        return onInstall({ ...payload, op: 'install', name: name.trim(), description: description.trim(), body })
      }
      return h(
        'div',
        { style: s.form },
        h(Field, { label: '新 skill 名（kebab-case）' }, h(TextInput, { value: name, onChange: e => setName(e.target.value), placeholder: 'my-skill' })),
        h(Field, { label: '描述（必填，模型按它决定是否加载）' }, h(TextInput, { value: description, onChange: e => setDescription(e.target.value), placeholder: '一句话说明什么时候用它' })),
        h(
          Field,
          { label: '安装地址（改这里就换目录）', wide: true },
          h(TextInput, { value: root, onChange: e => setRoot(e.target.value), placeholder: 'D:\\skills' }),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
            targets.map(target =>
              h(
                Button,
                { key: target.dir, title: target.dir, onClick: () => setRoot(target.dir) },
                `${target.source}${target.scanned ? '' : '（非扫描根）'}`,
              ),
            ),
          ),
          scanned
            ? null
            : h(
                'div',
                { style: { ...s.label, color: colors.warn, marginTop: '4px' } },
                '该目录不在扫描根内：文件会写进去，但 dsh-skill-filesystem 不会加载它。要生效，把它加进该插件的 customSkillDirs（或在 profile patch 里给它加一行）。',
              ),
        ),
        h(
          Field,
          { label: '或：从已存在的目录/文件导入（绝对路径）', wide: true },
          h(TextInput, { value: from, onChange: e => setFrom(e.target.value), placeholder: 'D:\\skills\\my-skill  （含 SKILL.md）' }),
        ),
        h(
          Field,
          { label: '正文（Markdown，可留空）', wide: true },
          h('textarea', { value: body, onChange: e => setBody(e.target.value), style: s.textarea, placeholder: '# 步骤…' }),
        ),
        h('div', { style: { ...s.wide, display: 'flex', justifyContent: 'flex-end' } }, h(Button, { kind: 'primary', busy, onClick: submit }, '安装 skill')),
      )
    }

    /** Delete by absolute path, so targets outside every scanned root stay removable. */
    function PathDelete({ busy, run }) {
      const [path, setPath] = useState('')
      const remove = () => {
        if (!path.trim()) return undefined
        return run({ domain: 'skill', op: 'delete', path: path.trim() })
      }
      return h(
        'div',
        { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h(TextInput, {
          value: path,
          onChange: event => setPath(event.target.value),
          placeholder: 'D:\\skills\\my-skill（不在扫描根里的 skill 用这个删）',
          style: { flex: '1 1 auto' },
        }),
        h(Button, { kind: 'danger', busy, onClick: remove }, '按路径删除'),
      )
    }

    function SkillsTab({ snapshot, busy, run, install }) {
      const skills = (snapshot && snapshot.skills) || { active: [], disabled: [], roots: [] }
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: s.sectionTitle },
          '已启用',
          h('span', { style: s.count }, String(skills.active.length)),
        ),
        skills.active.length === 0
          ? h('div', { style: s.banner() }, '当前扫描根下没有可用 skill。')
          : h(
              'div',
              { style: s.list },
              skills.active.map(skill =>
                h(SkillRow, {
                  key: skill.path,
                  skill,
                  busy,
                  onToggle: item => run({ domain: 'skill', op: 'disable', name: item.name }),
                  onDelete: item => run({ domain: 'skill', op: 'delete', name: item.name }),
                }),
              ),
            ),
        skills.disabled.length > 0
          ? h(
              React.Fragment,
              null,
              h('div', { style: s.sectionTitle }, '已禁用', h('span', { style: s.count }, String(skills.disabled.length))),
              h(
                'div',
                { style: s.list },
                skills.disabled.map(skill =>
                  h(SkillRow, {
                    key: skill.path,
                    skill,
                    busy,
                    onToggle: item => run({ domain: 'skill', op: 'enable', name: item.name }),
                    onDelete: item => run({ domain: 'skill', op: 'delete', name: item.name }),
                  }),
                ),
              ),
            )
          : null,
        h('div', { style: s.sectionTitle }, '安装'),
        h(InstallSkill, { busy, snapshot, onInstall: install }),
        h(PathDelete, { busy, run }),
        h(
          'div',
          { style: s.banner() },
          '扫描根：',
          skills.roots.map(root => `${root.dir}${root.exists ? '' : '（不存在）'}`).join('  ·  '),
        ),
      )
    }

    /* ------------------------------------------------------------------ mcp */

    function describeServer(server) {
      if (server.transport === 'stdio') {
        const args = Array.isArray(server.args) && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''
        return `${server.command || ''}${args}`
      }
      return server.url || ''
    }

    function McpRow({ server, busy, run }) {
      const [confirming, setConfirming] = useState(false)
      useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), 4000)
        return () => clearTimeout(timer)
      }, [confirming])
      return h(
        'div',
        { style: s.row },
        h(
          'div',
          { style: s.rowMain },
          h(
            'div',
            { style: s.rowName },
            server.serverName,
            h('span', { style: s.pill(server.enabled === false ? 'off' : 'on') }, server.enabled === false ? '已禁用' : '启用中'),
            h('span', { style: { ...s.count, fontSize: '10px' } }, server.transport),
          ),
          h('div', { style: s.rowPath, title: describeServer(server) }, describeServer(server)),
        ),
        h(
          'div',
          { style: s.actions },
          h(
            Button,
            {
              kind: server.enabled === false ? 'primary' : 'ghost',
              busy,
              onClick: () =>
                run({
                  domain: 'mcp',
                  op: server.enabled === false ? 'enable' : 'disable',
                  serverName: server.serverName,
                }),
            },
            server.enabled === false ? '启用' : '禁用',
          ),
          h(
            Button,
            {
              kind: 'danger',
              busy,
              onClick: () => {
                if (!confirming) {
                  setConfirming(true)
                  return
                }
                run({ domain: 'mcp', op: 'delete', serverName: server.serverName })
              },
            },
            confirming ? '确认删除' : '删除',
          ),
        ),
      )
    }

    function AddMcp({ busy, run }) {
      const [serverName, setServerName] = useState('')
      const [transport, setTransport] = useState('stdio')
      const [command, setCommand] = useState('npx')
      const [args, setArgs] = useState('')
      const [url, setUrl] = useState('')
      const [env, setEnv] = useState('')
      const submit = () => {
        const payload = { domain: 'mcp', op: 'add', serverName: serverName.trim(), transport, env }
        if (transport === 'stdio') {
          payload.command = command.trim()
          payload.args = args
        } else {
          payload.url = url.trim()
        }
        return run(payload)
      }
      return h(
        'div',
        { style: s.form },
        h(Field, { label: '服务器名（工具前缀 mcp__<名>__）' }, h(TextInput, { value: serverName, onChange: e => setServerName(e.target.value), placeholder: 'github' })),
        h(
          Field,
          { label: '传输' },
          h(
            'select',
            { value: transport, onChange: e => setTransport(e.target.value), style: s.input },
            h('option', { value: 'stdio' }, 'stdio（本地进程）'),
            h('option', { value: 'streamable-http' }, 'streamable-http（远端）'),
          ),
        ),
        transport === 'stdio'
          ? h(Field, { label: '命令' }, h(TextInput, { value: command, onChange: e => setCommand(e.target.value), placeholder: 'npx' }))
          : h(Field, { label: 'URL' }, h(TextInput, { value: url, onChange: e => setUrl(e.target.value), placeholder: 'http://127.0.0.1:3000/mcp' })),
        transport === 'stdio'
          ? h(Field, { label: '参数（每行一个）' }, h('textarea', { value: args, onChange: e => setArgs(e.target.value), style: s.textarea, placeholder: '-y\n@modelcontextprotocol/server-github' }))
          : h(Field, { label: '环境变量（每行 KEY=VALUE）' }, h('textarea', { value: env, onChange: e => setEnv(e.target.value), style: s.textarea, placeholder: 'GITHUB_TOKEN=xxx' })),
        transport === 'stdio'
          ? h(Field, { label: '环境变量（每行 KEY=VALUE）', wide: true }, h('textarea', { value: env, onChange: e => setEnv(e.target.value), style: s.textarea, placeholder: 'GITHUB_TOKEN=xxx' }))
          : null,
        h('div', { style: { ...s.wide, display: 'flex', justifyContent: 'flex-end' } }, h(Button, { kind: 'primary', busy, onClick: submit }, '安装 MCP 服务器')),
      )
    }

    function McpTab({ snapshot, busy, run }) {
      const mcp = (snapshot && snapshot.mcp) || { servers: [], patchPath: null }
      return h(
        React.Fragment,
        null,
        h('div', { style: s.sectionTitle }, '服务器', h('span', { style: s.count }, String(mcp.servers.length))),
        mcp.servers.length === 0
          ? h('div', { style: s.banner() }, '还没有由本面板管理的 MCP 服务器。')
          : h(
              'div',
              { style: s.list },
              mcp.servers.map(server => h(McpRow, { key: server.serverName, server, busy, run })),
            ),
        h('div', { style: s.sectionTitle }, '安装'),
        h(AddMcp, { busy, run }),
        h(
          'div',
          { style: s.banner() },
          mcp.patchPath
            ? `写入位置：${mcp.patchPath}（受管段落${mcp.blockPresent ? '已存在' : '尚未生成'}）`
            : '未检测到 profile 目录，MCP 行无法写入。',
        ),
      )
    }

    /* --------------------------------------------------------------- dialog */

    function ManagerDialog() {
      const [isOpen] = useOpen()
      const [tab, setTab] = useState('skills')
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const cardRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const payload = await request('/state')
          setSnapshot(payload)
          setError('')
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      useEffect(() => {
        if (!isOpen) return undefined
        void load()
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [isOpen, load])

      const run = useCallback(async body => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const payload = await request('/action', { method: 'POST', body: JSON.stringify(body) })
          if (payload && payload.result && payload.result.scanned === false) {
            setNotice(`已写入 ${payload.result.path}，但该目录不是扫描根：skill 不会出现在模型目录里。`)
          }
          if (payload && payload.skills && payload.mcp) setSnapshot(payload)
          else await load()
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
          await load()
        } finally {
          setBusy(false)
        }
      }, [load])

      const install = useCallback(body => run({ domain: 'skill', ...body }), [run])

      if (!isOpen) return null
      return h(
        'div',
        {
          style: s.backdrop,
          onMouseDown: event => {
            if (event.target === event.currentTarget) setOpen(false)
          },
        },
        h(
          'div',
          { style: s.card, ref: cardRef, role: 'dialog', 'aria-label': TITLE },
          h(
            'div',
            { style: s.header },
            h('h2', { style: s.title }, TITLE),
            h(
              'div',
              { style: s.tabs },
              h('button', { type: 'button', style: s.tab(tab === 'skills'), onClick: () => setTab('skills') }, '技能'),
              h('button', { type: 'button', style: s.tab(tab === 'mcp'), onClick: () => setTab('mcp') }, 'MCP'),
            ),
            h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
              h(Button, { busy, onClick: load }, '刷新'),
              h(Button, { onClick: () => setOpen(false) }, '关闭'),
            ),
          ),
          h(
            'div',
            { style: s.body },
            error ? h('div', { style: s.banner('error') }, error) : null,
            notice ? h('div', { style: { ...s.banner(), color: colors.warn, borderColor: colors.warn } }, notice) : null,
            !snapshot && !error ? h('div', { style: s.banner() }, '读取中…') : null,
            snapshot && tab === 'skills' ? h(SkillsTab, { snapshot, busy, run, install }) : null,
            snapshot && tab === 'mcp' ? h(McpTab, { snapshot, busy, run }) : null,
          ),
          h(
            'div',
            { style: s.footer },
            snapshot && snapshot.dshHome ? `DSH_HOME: ${snapshot.dshHome}` : '',
            snapshot && snapshot.profileDir ? ` · profile: ${snapshot.profileDir}` : '',
          ),
        ),
      )
    }

    function ManagerButton() {
      return h(
        'button',
        {
          type: 'button',
          title: TITLE,
          'aria-label': TITLE,
          onClick: () => setOpen(!open),
          style: s.icon24,
        },
        h(
          'svg',
          { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('rect', { x: 2.5, y: 4, width: 19, height: 6.5, rx: 2 }),
          h('rect', { x: 2.5, y: 13.5, width: 19, height: 6.5, rx: 2 }),
          h('circle', { cx: 7, cy: 7.25, r: 1.3 }),
          h('circle', { cx: 7, cy: 16.75, r: 1.3 }),
        ),
      )
    }

    const name = 'dsh-skill-mcp-manager'
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'skill-mcp-manager', order: 40 }, ManagerButton),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'skill-mcp-manager', order: 60 }, ManagerDialog),
      )
    }

    return { name, inject, apply }
  },
})

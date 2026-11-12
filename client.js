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
        position: 'relative',
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
      pill: kind => {
        const tone = kind === 'on' ? colors.success : kind === 'warn' ? colors.warn : colors.idle
        return {
          fontSize: '10px',
          padding: '1px 6px',
          borderRadius: '999px',
          border: `1px solid ${tone}`,
          color: kind === 'off' ? colors.muted : tone,
          fontWeight: 500,
        }
      },
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

    /**
     * Track one button's own outcome: idle → busy → ok | error, then back to
     * idle. The shared toast reports every mutation; this keeps the button the
     * user pressed answering for itself.
     */
    function useActionStatus() {
      const [status, setStatus] = useState('idle')
      const timer = useRef(null)
      const settle = useCallback(next => {
        setStatus(next)
        if (timer.current) clearTimeout(timer.current)
        if (next === 'ok' || next === 'error') {
          timer.current = setTimeout(() => setStatus('idle'), 4000)
        }
      }, [])
      useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
      }, [])
      const track = useCallback(async thunk => {
        settle('busy')
        try {
          const result = await thunk()
          settle(result && result.ok ? 'ok' : 'error')
          return result
        } catch (cause) {
          settle('error')
          return { ok: false, error: String((cause && cause.message) || cause) }
        }
      }, [settle])
      return [status, track]
    }

    const STATUS_TEXT = { busy: '处理中…', ok: '成功', error: '失败' }

    function StatusLine({ status, message }) {
      if (status === 'idle') return message ? h('div', { style: { ...s.label, color: colors.muted } }, message) : null
      const tone = status === 'ok' ? colors.success : status === 'error' ? colors.danger : colors.muted
      return h(
        'div',
        { style: { ...s.label, color: tone, display: 'flex', gap: '6px', alignItems: 'center' }, role: 'status', 'aria-live': 'polite' },
        h('span', { 'aria-hidden': true }, status === 'ok' ? '✓' : status === 'error' ? '✗' : '…'),
        h('span', null, message || STATUS_TEXT[status]),
      )
    }

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
            skill.modelVisible === false
              ? h('span', { style: s.pill('warn'), title: skill.modelInvisibleReason || '' }, '模型不可见')
              : null,
          ),
          skill.description ? h('div', { style: s.rowDesc }, skill.description) : null,
          skill.modelVisible === false && skill.modelInvisibleReason
            ? h('div', { style: { ...s.label, color: colors.warn } }, `模型不可见：${skill.modelInvisibleReason}`)
            : null,
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
      const [status, track] = useActionStatus()
      const [message, setMessage] = useState('')
      const scanned = targets.some(target => target.dir === root && target.scanned)
      const submit = async () => {
        const payload = { root: root.trim() || undefined }
        const body_ = from.trim()
          ? { ...payload, op: 'install', from: from.trim(), name: name.trim() || undefined }
          : { ...payload, op: 'install', name: name.trim(), description: description.trim(), body }
        const result = await track(() => onInstall(body_))
        if (result && result.ok) {
          const installed = result.payload && result.payload.result ? result.payload.result : {}
          setMessage(`已安装 ${installed.installed || name.trim()} → ${installed.path || root}`)
        } else {
          setMessage((result && result.error) || '安装失败')
        }
      }
      const label = status === 'busy' ? '安装中…' : status === 'ok' ? '✓ 安装成功' : status === 'error' ? '✗ 安装失败' : '安装 skill'
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
        h(
          'div',
          { style: { ...s.wide, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px' } },
          h(StatusLine, { status, message }),
          h(Button, { kind: 'primary', busy: busy || status === 'busy', onClick: submit }, label),
        ),
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

    /* ------------------------------------------------------------- dropzone */

    // Extensions shipped as text; everything else travels as base64 so a
    // dropped bundle keeps its assets byte-for-byte.
    const TEXT_EXT = new Set([
      '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini',
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.bat',
      '.html', '.htm', '.css', '.csv', '.xml', '.sql', '.gitignore', '',
    ])

    function extensionOf(name) {
      const index = String(name || '').lastIndexOf('.')
      return index <= 0 ? '' : String(name).slice(index).toLowerCase()
    }

    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
      }
      return btoa(binary)
    }

    /** Walk a dropped entry tree (folder support needs webkitGetAsEntry). */
    async function walkEntry(entry, prefix, out) {
      if (!entry) return
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
        out.push({ path: prefix ? `${prefix}/${file.name}` : file.name, file })
        return
      }
      if (!entry.isDirectory) return
      const reader = entry.createReader()
      const next = () => new Promise(resolve => reader.readEntries(resolve, () => resolve([])))
      const folder = prefix ? `${prefix}/${entry.name}` : entry.name
      let batch = await next()
      while (batch.length > 0) {
        for (const child of batch) await walkEntry(child, folder, out)
        batch = await next()
      }
    }

    async function collectDropped(dataTransfer) {
      const items = Array.from(dataTransfer.items || [])
      const entries = items
        .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
        .filter(Boolean)
      if (entries.length > 0) {
        const out = []
        for (const entry of entries) await walkEntry(entry, '', out)
        return out
      }
      return Array.from(dataTransfer.files || []).map(file => ({ path: file.name, file }))
    }

    async function filePayload(entry) {
      const name = entry.path
      if (TEXT_EXT.has(extensionOf(name))) {
        return { path: name, text: await entry.file.text() }
      }
      const buffer = await entry.file.arrayBuffer()
      return { path: name, base64: toBase64(new Uint8Array(buffer)) }
    }

    function DropZone({ busy, snapshot, onImport }) {
      const [dragging, setDragging] = useState(false)
      const [reading, setReading] = useState('')
      const [status, track] = useActionStatus()
      const [message, setMessage] = useState('')
      const fileInput = useRef(null)
      const dirInput = useRef(null)
      const root = (snapshot && snapshot.installRoot) || ''

      const upload = useCallback(async payload => {
        const result = await track(() => onImport(payload))
        const installed = result && result.ok && result.payload && result.payload.result ? result.payload.result : null
        if (installed) {
          const count = Array.isArray(installed.files) ? installed.files.length : 0
          setMessage(`已导入 ${installed.installed}（${count} 个文件）→ ${installed.path}`)
        } else {
          setMessage((result && result.error) || '导入失败')
        }
        return result
      }, [onImport, track])

      const handleFiles = useCallback(async entries => {
        if (!entries || entries.length === 0) return
        setReading('读取中…')
        try {
          const zips = entries.filter(entry => extensionOf(entry.path) === '.zip')
          if (zips.length === 1 && entries.length === 1) {
            const buffer = await zips[0].file.arrayBuffer()
            if (buffer.byteLength > 12 * 1024 * 1024) throw new Error('zip 超过 12 MB 上限')
            setReading(`解析 ${zips[0].path}`)
            await upload({ op: 'import', zip: toBase64(new Uint8Array(buffer)), root })
          } else if (zips.length > 0) {
            throw new Error('一次只支持拖入一个 zip，或拖入文件夹')
          } else {
            const files = []
            let total = 0
            for (const entry of entries) {
              const payload = await filePayload(entry)
              const size = payload.text !== undefined ? payload.text.length : Math.floor((payload.base64.length * 3) / 4)
              total += size
              if (total > 12 * 1024 * 1024) throw new Error('拖入内容超过 12 MB 上限')
              files.push(payload)
            }
            setReading(`上传 ${files.length} 个文件`)
            await upload({ op: 'import', files, root })
          }
        } catch (cause) {
          setMessage(String((cause && cause.message) || cause))
        } finally {
          setReading('')
        }
      }, [root, upload])

      const onDrop = useCallback(async event => {
        event.preventDefault()
        setDragging(false)
        try {
          await handleFiles(await collectDropped(event.dataTransfer))
        } catch (cause) {
          console.error('[skill-mcp-manager] drop failed', cause)
        }
      }, [handleFiles])

      const inputProps = {
        type: 'file',
        multiple: true,
        style: { display: 'none' },
        onChange: async event => {
          const chosen = event.target.files
          if (!chosen || chosen.length === 0) return
          const entries = Array.from(chosen).map(file => ({
            path: file.webkitRelativePath && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name,
            file,
          }))
          const picked = event.target
          try {
            await handleFiles(entries)
          } finally {
            picked.value = ''
          }
        },
      }

      return h(
        'div',
        {
          onDragOver: event => {
            event.preventDefault()
            setDragging(true)
          },
          onDragLeave: () => setDragging(false),
          onDrop,
          style: {
            border: `1px dashed ${dragging ? colors.brand : colors.borderStrong}`,
            background: dragging ? colors.layer2 : colors.base,
            borderRadius: '10px',
            padding: '18px 14px',
            textAlign: 'center',
            color: colors.muted,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            alignItems: 'center',
          },
        },
        h('div', { style: { color: colors.text, fontSize: '13px', fontWeight: 600 } }, '拖入 skill 文件夹、SKILL.md 或 .zip'),
        h('div', null, '整包解析：保留 references / scripts / assets，自动读 frontmatter 定名，缺描述会补齐'),
        h('div', { style: { fontSize: '11px' } }, root ? `安装到 ${root}` : '安装地址未设置'),
        h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          h(Button, { busy: Boolean(busy || reading), onClick: () => dirInput.current && dirInput.current.click() }, '选择文件夹'),
          h(Button, { busy: Boolean(busy || reading), onClick: () => fileInput.current && fileInput.current.click() }, '选择文件 / zip'),
        ),
        reading ? h('div', { style: { color: colors.brand } }, reading) : null,
        h(StatusLine, { status, message }),
        h('input', { ...inputProps, accept: '.zip,.md,.markdown,.txt', ref: fileInput }),
        h('input', { ...inputProps, webkitdirectory: '', directory: '', ref: dirInput }),
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
        h(DropZone, { busy, snapshot, onImport: install }),
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
      const [status, track] = useActionStatus()
      const [message, setMessage] = useState('')
      const submit = async () => {
        const payload = { domain: 'mcp', op: 'add', serverName: serverName.trim(), transport, env }
        if (transport === 'stdio') {
          payload.command = command.trim()
          payload.args = args
        } else {
          payload.url = url.trim()
        }
        const result = await track(() => run(payload))
        if (result && result.ok) {
          const added = result.payload && result.payload.result ? result.payload.result.server : null
          setMessage(`已添加 ${added ? added.serverName : payload.serverName}${added && added.cwd ? `（工作目录 ${added.cwd}）` : ''}`)
        } else {
          setMessage((result && result.error) || '添加失败')
        }
        return result
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
        h(
          'div',
          { style: { ...s.wide, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px' } },
          h(StatusLine, { status, message }),
          h(Button, { kind: 'primary', busy: busy || status === 'busy', onClick: submit }, status === 'busy' ? '添加中…' : status === 'ok' ? '✓ 已添加' : status === 'error' ? '✗ 添加失败' : '安装 MCP 服务器'),
        ),
      )
    }

    function McpTab({ snapshot, busy, run }) {
      const mcp = (snapshot && snapshot.mcp) || { servers: [], patchPath: null }
      const expected = mcp.servers.filter(server => server.enabled !== false).map(server => server.serverName)
      return h(
        React.Fragment,
        null,
        mcp.consistent === false
          ? h(
              'div',
              { style: { ...s.banner(), color: colors.warn, borderColor: colors.warn } },
              `状态与 patch 不一致：状态期望 [${expected.join(', ') || '空'}]，patch 受管段落里是 [${(mcp.blockServers || []).join(', ') || '空'}]。对任一服务器做一次启用/禁用即可重写段落。`,
            )
          : null,
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

    /** Human summary of one completed action, used by the toast. */
    function describeAction(body, payload) {
      const result = (payload && payload.result) || {}
      const op = String((body && body.op) || '')
      if (body && body.domain === 'skill') {
        if (op === 'install') return `已安装 skill ${result.installed || body.name} → ${result.path || ''}`
        if (op === 'import') return `已导入 skill ${result.installed}（${(result.files || []).length} 个文件）`
        if (op === 'disable') return `已禁用 skill ${result.name}`
        if (op === 'enable') return `已启用 skill ${result.name}`
        if (op === 'delete') return `已删除 skill ${result.name}`
        return 'skill 操作完成'
      }
      if (body && body.domain === 'mcp') {
        if (op === 'add') return `已添加 MCP 服务器 ${result.server && result.server.serverName}`
        if (op === 'update') return `已更新 MCP 服务器 ${result.server && result.server.serverName}`
        if (op === 'enable') return `已启用 MCP 服务器 ${result.server && result.server.serverName}`
        if (op === 'disable') return `已禁用 MCP 服务器 ${result.server && result.server.serverName}`
        if (op === 'delete') return `已删除 MCP 服务器 ${result.removed && result.removed.serverName}`
        return 'MCP 操作完成'
      }
      return '操作完成'
    }

    /** Label for the intent alone, used when the action failed and there is no result. */
    function actionLabel(body) {
      const op = String((body && body.op) || '')
      const name = (body && (body.name || body.serverName)) || ''
      if (body && body.domain === 'skill') {
        if (op === 'install') return '安装 skill'
        if (op === 'import') return '导入 skill'
        if (op === 'disable') return `禁用 skill ${name}`
        if (op === 'enable') return `启用 skill ${name}`
        if (op === 'delete') return `删除 skill ${name || (body && body.path) || ''}`
      }
      if (body && body.domain === 'mcp') {
        if (op === 'add') return `添加 MCP 服务器 ${name}`
        if (op === 'update') return `更新 MCP 服务器 ${name}`
        if (op === 'enable') return `启用 MCP 服务器 ${name}`
        if (op === 'disable') return `禁用 MCP 服务器 ${name}`
        if (op === 'delete') return `删除 MCP 服务器 ${name}`
      }
      return '操作'
    }

    function Toast({ toast, onDismiss }) {
      if (!toast) return null
      const tone = toast.kind === 'ok' ? colors.success : colors.danger
      return h(
        'div',
        {
          role: 'status',
          'aria-live': 'polite',
          style: {
            position: 'absolute',
            top: '58px',
            right: '18px',
            maxWidth: '70%',
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: '9px',
            border: `1px solid ${tone}`,
            color: tone,
            background: colors.layer1,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            fontSize: '12px',
          },
        },
        h('span', { 'aria-hidden': true }, toast.kind === 'ok' ? '✓' : '✗'),
        h('span', { style: { whiteSpace: 'pre-wrap' } }, toast.text),
        h(
          'button',
          { type: 'button', onClick: onDismiss, style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 2px', font: 'inherit' }, 'aria-label': '关闭提示' },
          '×',
        ),
      )
    }

    function ManagerDialog() {
      const [isOpen] = useOpen()
      const [tab, setTab] = useState('skills')
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [toast, setToast] = useState(null)
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
          const warnings = payload && payload.result && Array.isArray(payload.result.warnings)
            ? payload.result.warnings
            : []
          if (warnings.length > 0) setNotice(warnings.join(' '))
          else if (payload && payload.result && payload.result.scanned === false) {
            setNotice(`已写入 ${payload.result.path}，但该目录不是扫描根：skill 不会出现在模型目录里。`)
          }
          if (payload && payload.skills && payload.mcp) setSnapshot(payload)
          else await load()
          setToast({ kind: 'ok', text: describeAction(body, payload), at: Date.now() })
          return { ok: true, payload }
        } catch (cause) {
          const message = String((cause && cause.message) || cause)
          setError(message)
          setToast({ kind: 'error', text: `${actionLabel(body)} 失败：${message}`, at: Date.now() })
          await load()
          return { ok: false, error: message }
        } finally {
          setBusy(false)
        }
      }, [load])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 6000)
        return () => clearTimeout(timer)
      }, [toast])

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
          h(Toast, { toast, onDismiss: () => setToast(null) }),
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

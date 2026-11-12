/**
 * dsh-skill-mcp-manager — Host half.
 *
 * One place to manage local skills (SKILL.md bundles) and MCP servers:
 *   - skills: list / enable / disable (quarantine under <root>/.disabled) / delete / install / import
 *   - mcp:    list / add / enable / disable / remove / update
 *
 * The MCP half owns a managed block inside the profile's `cordis.patch.yml`;
 * rewriting that block is how a server row appears, disappears, or is parked.
 * The Loader applies the patch layer, so no separate file format is invented
 * here.
 *
 * All mutations are also exposed over HTTP under `/skill-mcp-manager`, which is
 * the only channel the browser half uses.
 */

import { promises as fs } from 'node:fs'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'skill-mcp-manager'

/** The routes need the browser-facing HTTP server; everything else is Node. */
export const inject = ['webServer']

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = 'dsh-skill-mcp-manager'
const MOUNT = '/skill-mcp-manager'
const BLOCK_START = '# >>> dsh-skill-mcp-manager (managed) — 本段由管理器生成，手改会被覆盖'
const BLOCK_END = '# <<< dsh-skill-mcp-manager'
const QUARANTINE = '.disabled'
const SKILL_FILE = 'SKILL.md'
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SERVER_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Active profile directory, resolved once per process. */
let resolvedProfileDir
/** Profile directory published by the running composition, when present. */
let contextProfileDir

/** Absolute DSH home (`$DSH_HOME`, else `~/.dsh`). */
function dshHome() {
  return process.env.DSH_HOME || join(os.homedir(), '.dsh')
}

/** Shared agent home that also hosts skills (`$DSH_AGENTS_HOME`, else `~/.agents`). */
function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(os.homedir(), '.agents')
}

/**
 * Find the profile that installed this bundle.
 *
 * `DSH_PROFILE_DIR` is a shell environment value, not a Host one, and the
 * composition's `profileContext` is not always mounted, so the last resort is
 * the install itself: the profile whose `node_modules/<name>` resolves to this
 * package is the one whose patch layer must carry the managed block.
 */
function profileDir() {
  if (resolvedProfileDir !== undefined) return resolvedProfileDir
  if (process.env.DSH_PROFILE_DIR) {
    resolvedProfileDir = process.env.DSH_PROFILE_DIR
    return resolvedProfileDir
  }
  if (contextProfileDir) {
    resolvedProfileDir = contextProfileDir
    return resolvedProfileDir
  }
  const profilesRoot = join(dshHome(), 'profiles')
  let own = PACKAGE_DIR
  try {
    own = realpathSync(PACKAGE_DIR)
  } catch {
    own = PACKAGE_DIR
  }
  let candidates = []
  try {
    candidates = readdirSync(profilesRoot)
  } catch {
    candidates = []
  }
  let best = null
  for (const entry of candidates) {
    const linked = join(profilesRoot, entry, 'node_modules', PACKAGE_NAME)
    try {
      if (realpathSync(linked) !== own) continue
    } catch {
      continue
    }
    let stamp = 0
    try {
      stamp = statSync(join(profilesRoot, entry, 'package.json')).mtimeMs
    } catch {
      stamp = 0
    }
    if (!best || stamp > best.stamp) best = { dir: join(profilesRoot, entry), stamp }
  }
  resolvedProfileDir = best ? best.dir : null
  return resolvedProfileDir
}

/** The profile's user patch layer, when a profile is known. */
function patchPath() {
  const dir = profileDir()
  return dir ? join(dir, 'cordis.patch.yml') : null
}

/** Where this plugin keeps its own MCP definitions. */
function statePath() {
  return join(dshHome(), 'skill-mcp-manager', 'state.json')
}

/** Skill roots in precedence order, mirroring the filesystem provider's ranks. */
function skillRoots(config) {
  const roots = [
    { source: 'user-dsh', dir: join(dshHome(), 'skills') },
    { source: 'user-agents', dir: join(agentsHome(), 'skills') },
  ]
  const custom = Array.isArray(config?.customSkillDirs) ? config.customSkillDirs : []
  for (const dir of custom) {
    if (typeof dir === 'string' && dir.trim()) roots.push({ source: 'custom', dir: resolve(dir) })
  }
  return roots
}

/**
 * Directories the panel offers as install targets: the scanned roots plus any
 * extra directory this row's `extraRoots` config lists.
 *
 * A target outside every scanned root still receives the files, but no provider
 * discovers it — the filesystem provider only reads its own configured roots —
 * so the panel labels that case instead of pretending the skill went live.
 */
function installTargets(config) {
  const targets = skillRoots(config).map(root => ({ dir: root.dir, source: root.source, scanned: true }))
  const extra = Array.isArray(config?.extraRoots) ? config.extraRoots : []
  for (const dir of extra) {
    if (typeof dir !== 'string' || !dir.trim()) continue
    const resolved = resolve(dir)
    if (targets.some(target => target.dir === resolved)) continue
    targets.push({ dir: resolved, source: 'extra', scanned: false })
  }
  const install = config?.installRoot ? resolve(String(config.installRoot)) : null
  if (install && !targets.some(target => target.dir === install)) {
    targets.push({ dir: install, source: 'installRoot', scanned: true })
  }
  return targets
}

/** Resolve where an install writes: explicit request, then config, then the first existing root. */
function resolveInstallRoot(config, requested) {
  if (requested && String(requested).trim()) return resolve(String(requested).trim())
  if (config?.installRoot && String(config.installRoot).trim()) return resolve(String(config.installRoot).trim())
  const roots = skillRoots(config)
  return roots.find(root => existsSync(root.dir))?.dir ?? roots[0].dir
}

/**
 * Where MCP servers keep their working directory and package cache.
 *
 * An MCP server has no "install directory" of its own — a stdio server is a
 * command the client spawns — so relocating it means two things: give the child
 * a `cwd` on the chosen disk, and point npm's cache there so `npx` does not
 * unpack into the user profile on C:.
 */
function mcpRoot(config) {
  if (config?.mcpRoot && String(config.mcpRoot).trim()) return resolve(String(config.mcpRoot).trim())
  return join(dshHome(), 'mcp')
}

/** Create the server's home on the chosen disk and fill in disk-locating defaults. */
async function locateServer(config, server) {
  const root = mcpRoot(config)
  const home = join(root, server.serverName)
  await fs.mkdir(home, { recursive: true })
  if (server.transport === 'stdio') {
    if (!server.cwd) server.cwd = home
    const env = { ...(server.env || {}) }
    if (!env.npm_config_cache) env.npm_config_cache = join(root, '.npm-cache')
    if (!env.npm_config_store_dir) env.npm_config_store_dir = join(root, '.pnpm-store')
    server.env = env
  }
  return server
}

async function readText(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Split a SKILL.md into frontmatter text and body. */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text }
  const lines = text.split(/\r?\n/)
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      return {
        frontmatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n').replace(/^\r?\n/, ''),
      }
    }
  }
  return { frontmatter: '', body: text }
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"')
  }
  return value
}

/** Read the two frontmatter fields the manager shows: `name` and `description`. */
function parseFrontmatter(frontmatter) {
  const out = {}
  const lines = frontmatter.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if (value === '' || value === '>' || value === '|' || value === '>-' || value === '|-') {
      const collected = []
      let j = i + 1
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        collected.push(lines[j].trim())
        j += 1
      }
      i = j - 1
      value = collected.join(value.startsWith('|') ? '\n' : ' ').trim()
    } else {
      value = unquote(value)
    }
    if (key === 'name' || key === 'description') out[key] = value
  }
  return out
}

/** One directory entry described as a skill, from either the live root or quarantine. */
async function describeEntry(root, entry, disabled) {
  const entryPath = join(root, entry.name)
  let stat
  try {
    stat = await fs.stat(entryPath)
  } catch {
    return null
  }
  let name = entry.name
  let instructionsPath
  if (stat.isDirectory()) {
    instructionsPath = join(entryPath, SKILL_FILE)
    if (!existsSync(instructionsPath)) return null
  } else if (entry.name.toLowerCase().endsWith('.md')) {
    instructionsPath = entryPath
    name = entry.name.slice(0, -3)
  } else {
    return null
  }
  const text = await readText(instructionsPath)
  const parsed = parseFrontmatter(splitFrontmatter(text || '').frontmatter)
  // The scanned root may be a junction (a D-drive store seen through a C-drive
  // path); reporting the resolved path keeps the panel honest about where the
  // bytes actually live.
  const realPath = await fs.realpath(instructionsPath).catch(() => null)
  return {
    name: parsed.name || name,
    entry: entry.name,
    folder: stat.isDirectory(),
    description: parsed.description || '',
    path: instructionsPath,
    realPath,
    root,
    disabled,
    bytes: Buffer.byteLength(text || ''),
  }
}

/** Scan every root, splitting live entries from quarantined ones. */
async function listSkills(config) {
  const active = []
  const disabled = []
  const roots = []
  for (const root of skillRoots(config)) {
    const exists = existsSync(root.dir)
    roots.push({ source: root.source, dir: root.dir, exists })
    if (!exists) continue
    let entries = []
    try {
      entries = await fs.readdir(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === SKILL_FILE) continue
      if (!entry.isDirectory() && !entry.isFile()) continue
      const described = await describeEntry(root.dir, entry, false)
      if (described) active.push(described)
    }
    const quarantineDir = join(root.dir, QUARANTINE)
    if (existsSync(quarantineDir)) {
      let parked = []
      try {
        parked = await fs.readdir(quarantineDir, { withFileTypes: true })
      } catch {
        parked = []
      }
      for (const entry of parked) {
        if (entry.name.startsWith('.')) continue
        const described = await describeEntry(quarantineDir, entry, true)
        if (described) disabled.push(described)
      }
    }
  }
  active.sort((a, b) => a.name.localeCompare(b.name))
  disabled.sort((a, b) => a.name.localeCompare(b.name))
  return { active, disabled, roots }
}

/** Find one skill by installed name, requiring the state the caller expects. */
async function locateSkill(config, target, wantDisabled) {
  const listing = await listSkills(config)
  const pool = (wantDisabled ? listing.disabled : listing.active).concat(
    wantDisabled ? listing.active : listing.disabled,
  )
  const hit = pool.find(skill => skill.name === target || skill.entry === target)
  if (!hit) throw new Error(`找不到 skill "${target}"`)
  if (hit.disabled !== wantDisabled) {
    throw new Error(`skill "${target}" 当前${hit.disabled ? '已禁用' : '已启用'}，状态与请求不符`)
  }
  return hit
}

/** Move a skill between its live root and `<root>/.disabled`. */
async function toggleSkill(config, target, disable) {
  const skill = await locateSkill(config, target, !disable)
  const from = join(skill.root, skill.entry)
  let destination
  if (disable) {
    const quarantine = join(skill.root, QUARANTINE)
    await fs.mkdir(quarantine, { recursive: true })
    destination = join(quarantine, skill.entry)
  } else {
    const live = dirname(skill.root)
    await fs.mkdir(live, { recursive: true })
    destination = join(live, skill.entry)
  }
  if (existsSync(destination)) throw new Error(`目标位置已存在同名条目: ${destination}`)
  await fs.rename(from, destination)
  return { name: skill.name, disabled: disable, path: destination }
}

/** Delete a skill from wherever it currently sits, or by an explicit absolute path. */
async function removeSkill(config, target, explicitPath) {
  if (explicitPath && String(explicitPath).trim()) {
    const path = resolve(String(explicitPath).trim())
    const stat = await fs.stat(path).catch(() => null)
    if (!stat) throw new Error(`路径不存在: ${path}`)
    await fs.rm(path, { recursive: true, force: true })
    return { name: basename(path), removedFrom: path, scanned: false }
  }
  const listing = await listSkills(config)
  const hit = listing.active.concat(listing.disabled).find(skill => skill.name === target || skill.entry === target)
  if (!hit) throw new Error(`找不到 skill "${target}"`)
  await fs.rm(join(hit.root, hit.entry), { recursive: true, force: true })
  return { name: hit.name, removedFrom: join(hit.root, hit.entry), disabled: hit.disabled, scanned: true }
}

function yamlScalar(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** Render the frontmatter a freshly created skill starts with. */
function renderFrontmatter(name, description) {
  const text = String(description || '').trim()
  if (text.includes('\n')) {
    const lines = ['---', `name: ${name}`, 'description: >-']
    for (const line of text.split(/\r?\n/)) lines.push(`  ${line.trim()}`)
    lines.push('---', '')
    return lines.join('\n')
  }
  return ['---', `name: ${name}`, `description: ${yamlScalar(text)}`, '---', ''].join('\n')
}

/** Create a new skill, or import an existing directory bundle. */
async function installSkill(config, payload) {
  const targetRoot = resolveInstallRoot(config, payload.root)
  await fs.mkdir(targetRoot, { recursive: true })
  const scanned = skillRoots(config).some(root => root.dir === targetRoot)

  if (payload.from) {
    const source = resolve(String(payload.from))
    const stat = await fs.stat(source).catch(() => null)
    if (!stat) throw new Error(`导入源不存在: ${source}`)
    const entry = payload.name || basename(source)
    if (!NAME_PATTERN.test(entry)) throw new Error(`skill 名必须是 kebab-case: ${entry}`)
    const destination = join(targetRoot, entry)
    if (existsSync(destination)) throw new Error(`目标已存在: ${destination}`)
    if (stat.isDirectory()) {
      if (!existsSync(join(source, SKILL_FILE))) {
        throw new Error(`导入源缺少 ${SKILL_FILE}: ${source}`)
      }
      await fs.cp(source, destination, { recursive: true })
    } else {
      await fs.mkdir(destination, { recursive: true })
      await fs.copyFile(source, join(destination, SKILL_FILE))
    }
    const described = await describeEntry(targetRoot, { name: entry }, false)
    return { installed: entry, path: destination, root: targetRoot, scanned, skill: described }
  }

  const entry = String(payload.name || '').trim()
  if (!NAME_PATTERN.test(entry)) throw new Error('skill 名必须是小写 kebab-case，例如 my-skill')
  if (!String(payload.description || '').trim()) throw new Error('description 必填')
  const destination = join(targetRoot, entry)
  if (existsSync(destination)) throw new Error(`目标已存在: ${destination}`)
  await fs.mkdir(destination, { recursive: true })
  const body = String(payload.body || '').trim()
  const content = `${renderFrontmatter(entry, payload.description)}${body || `# ${entry}`}\n`
  await fs.writeFile(join(destination, SKILL_FILE), content, 'utf8')
  const described = await describeEntry(targetRoot, { name: entry }, false)
  return { installed: entry, path: destination, root: targetRoot, scanned, skill: described }
}

/* -------------------------------------------------------------------- MCP */

async function readState() {
  const raw = await readText(statePath())
  if (!raw) return { version: 1, mcp: [] }
  try {
    const parsed = JSON.parse(raw)
    return { version: 1, mcp: Array.isArray(parsed.mcp) ? parsed.mcp : [] }
  } catch {
    return { version: 1, mcp: [] }
  }
}

async function writeState(state) {
  const path = statePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(temp, path)
}

function rowId(server) {
  return `mcp-${server.serverName}`
}

function yamlKey(key) {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : yamlScalar(key)
}

/** Render one server as a Loader `insert` row holding a `dsh-mcp-client` config. */
function renderServerRow(server, indent) {
  const pad = ' '.repeat(indent)
  const lines = [
    `${pad}- id: ${rowId(server)}`,
    `${pad}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${pad}  config:`,
    `${pad}    serverName: ${yamlScalar(server.serverName)}`,
    `${pad}    transport: ${yamlScalar(server.transport)}`,
  ]
  if (server.transport === 'stdio') {
    if (server.command) lines.push(`${pad}    command: ${yamlScalar(server.command)}`)
    if (Array.isArray(server.args) && server.args.length > 0) {
      lines.push(`${pad}    args:`)
      for (const arg of server.args) lines.push(`${pad}      - ${yamlScalar(arg)}`)
    }
    if (server.cwd) lines.push(`${pad}    cwd: ${yamlScalar(server.cwd)}`)
  } else if (server.url) {
    lines.push(`${pad}    url: ${yamlScalar(server.url)}`)
  }
  const env = server.env && typeof server.env === 'object' ? Object.entries(server.env) : []
  if (env.length > 0) {
    lines.push(`${pad}    env:`)
    for (const [key, value] of env) lines.push(`${pad}      ${yamlKey(key)}: ${yamlScalar(value)}`)
  }
  const headers = server.headers && typeof server.headers === 'object' ? Object.entries(server.headers) : []
  if (headers.length > 0 && server.transport !== 'stdio') {
    lines.push(`${pad}    headers:`)
    for (const [key, value] of headers) lines.push(`${pad}      ${yamlKey(key)}: ${yamlScalar(value)}`)
  }
  return lines
}

/**
 * Compose the whole managed block for the current definitions.
 *
 * A disabled server contributes no row at all: the block is the row's only
 * home, so omitting it disables it, and no dangling override entry is left
 * behind for a row nothing else declares.
 */
function renderBlock(state) {
  const lines = [BLOCK_START]
  const enabled = state.mcp.filter(server => server.enabled !== false)
  const parked = state.mcp.filter(server => server.enabled === false)
  for (const server of parked) lines.push(`# 已禁用（不进入组合）: ${server.serverName}`)
  if (enabled.length > 0) {
    lines.push('- insert:')
    for (const server of enabled) lines.push(...renderServerRow(server, 4))
  }
  lines.push(BLOCK_END)
  return lines.join('\n')
}

/** Replace the managed block in the profile patch, preserving everything else. */
async function syncBlock(state) {
  const path = patchPath()
  if (!path) throw new Error('找不到 profile 目录，无法写入 MCP 行')
  let text = await readText(path)
  if (text === null) {
    await fs.mkdir(dirname(path), { recursive: true })
    text = ''
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === BLOCK_START)
  const end = start === -1 ? -1 : lines.findIndex((line, index) => index > start && line.trim() === BLOCK_END)
  const head = start === -1 ? lines : lines.slice(0, start)
  const tail = end === -1 ? [] : lines.slice(end + 1)
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop()
  while (tail.length > 0 && tail[0].trim() === '') tail.shift()
  // No servers left: remove the block instead of leaving empty markers in the
  // user's patch layer.
  const block = state.mcp.length > 0 ? renderBlock(state) : null
  const parts = []
  if (head.length > 0) parts.push(head.join('\n'))
  if (block) parts.push(block)
  if (tail.length > 0) parts.push(tail.join('\n'))
  const body = parts.length > 0 ? `${parts.join('\n\n').replace(/\n+$/, '')}\n` : ''
  const temp = `${path}.${process.pid}.tmp`
  await fs.writeFile(temp, body, 'utf8')
  await fs.rename(temp, path)
  return path
}

function toRecord(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out = {}
    for (const [key, value] of Object.entries(input)) {
      if (String(key).trim() === '') continue
      out[String(key)] = String(value ?? '')
    }
    return out
  }
  const out = {}
  for (const line of String(input || '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(line)
    if (match) out[match[1]] = match[2]
  }
  return out
}

function normalizeServer(input, previous) {
  const server = { ...(previous || {}) }
  if (input.serverName !== undefined) server.serverName = String(input.serverName).trim()
  if (input.transport !== undefined) server.transport = String(input.transport).trim()
  if (input.command !== undefined) server.command = String(input.command).trim()
  if (input.cwd !== undefined) server.cwd = String(input.cwd).trim()
  if (input.url !== undefined) server.url = String(input.url).trim()
  if (input.args !== undefined) {
    const args = Array.isArray(input.args)
      ? input.args
      : String(input.args).split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    server.args = args.map(item => String(item))
  }
  if (input.env !== undefined) server.env = toRecord(input.env)
  if (input.headers !== undefined) server.headers = toRecord(input.headers)
  if (input.enabled !== undefined) server.enabled = Boolean(input.enabled)
  if (!SERVER_PATTERN.test(server.serverName || '')) {
    throw new Error('serverName 只能包含字母、数字、下划线和连字符（1-32 位）')
  }
  if (server.transport !== 'stdio' && server.transport !== 'streamable-http') {
    throw new Error('transport 必须是 stdio 或 streamable-http')
  }
  if (server.transport === 'stdio' && !server.command) throw new Error('stdio 传输必须填写 command')
  if (server.transport === 'streamable-http' && !server.url) throw new Error('streamable-http 传输必须填写 url')
  if (server.enabled === undefined) server.enabled = true
  return server
}

async function mcpList() {
  const state = await readState()
  const path = patchPath()
  const patch = path ? await readText(path) : null
  return {
    servers: state.mcp,
    patchPath: path,
    patchPresent: patch !== null,
    blockPresent: patch ? patch.includes(BLOCK_START) : false,
  }
}

async function mcpAdd(config, input) {
  const state = await readState()
  const server = await locateServer(config, normalizeServer(input))
  if (state.mcp.some(entry => entry.serverName === server.serverName)) {
    throw new Error(`serverName 已存在: ${server.serverName}`)
  }
  state.mcp.push(server)
  await writeState(state)
  const patch = await syncBlock(state)
  return { server, patchPath: patch }
}

async function mcpUpdate(config, input) {
  const state = await readState()
  const index = state.mcp.findIndex(entry => entry.serverName === input.serverName)
  if (index === -1) throw new Error(`找不到 MCP 服务器 "${input.serverName}"`)
  state.mcp[index] = await locateServer(config, normalizeServer(input, state.mcp[index]))
  await writeState(state)
  const patch = await syncBlock(state)
  return { server: state.mcp[index], patchPath: patch }
}

async function mcpSetEnabled(input) {
  const state = await readState()
  const index = state.mcp.findIndex(entry => entry.serverName === input.serverName)
  if (index === -1) throw new Error(`找不到 MCP 服务器 "${input.serverName}"`)
  state.mcp[index].enabled = Boolean(input.enabled)
  await writeState(state)
  const patch = await syncBlock(state)
  return { server: state.mcp[index], patchPath: patch }
}

async function mcpRemove(input) {
  const state = await readState()
  const index = state.mcp.findIndex(entry => entry.serverName === input.serverName)
  if (index === -1) throw new Error(`找不到 MCP 服务器 "${input.serverName}"`)
  const [removed] = state.mcp.splice(index, 1)
  await writeState(state)
  const patch = await syncBlock(state)
  return { removed, patchPath: patch }
}

/* ----------------------------------------------------------------- routes */

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

async function snapshot(config) {
  const [skills, mcp] = await Promise.all([listSkills(config), mcpList()])
  return {
    build: 'v7',
    now: Date.now(),
    dshHome: dshHome(),
    agentsHome: agentsHome(),
    profileDir: profileDir(),
    installRoot: resolveInstallRoot(config),
    installTargets: installTargets(config),
    mcpRoot: mcpRoot(config),
    skills,
    mcp,
  }
}

async function act(config, body) {
  const domain = String(body.domain || '')
  const op = String(body.op || '')
  if (domain === 'skill') {
    if (op === 'disable') return toggleSkill(config, String(body.name), true)
    if (op === 'enable') return toggleSkill(config, String(body.name), false)
    if (op === 'delete') return removeSkill(config, String(body.name || ''), body.path)
    if (op === 'install') return installSkill(config, body)
    throw new Error(`未知的 skill 操作: ${op}`)
  }
  if (domain === 'mcp') {
    if (op === 'add') return mcpAdd(config, body)
    if (op === 'update') return mcpUpdate(config, body)
    if (op === 'enable') return mcpSetEnabled({ serverName: body.serverName, enabled: true })
    if (op === 'disable') return mcpSetEnabled({ serverName: body.serverName, enabled: false })
    if (op === 'delete') return mcpRemove(body)
    throw new Error(`未知的 mcp 操作: ${op}`)
  }
  throw new Error(`未知的管理域: ${domain}`)
}

export function apply(ctx, config) {
  try {
    const profile = ctx.get('profileContext')
    if (profile && typeof profile.dir === 'string' && profile.dir) contextProfileDir = profile.dir
  } catch {
    /* the composition may not mount a profile context */
  }

  ctx.effect(() => {
    const registered = []
    const route = (kind, path, handler) => {
      try {
        registered.push(ctx.webServer.register({ kind, path, handler }))
      } catch (error) {
        console.warn('[skill-mcp-manager] route', path, String(error?.message || error))
      }
    }

    route('exact', MOUNT, async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        sendJson(response, 200, { ok: true, ...(await snapshot(config)) })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message || error) })
      }
    })

    route('prefix', MOUNT, async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const tail = url.pathname.slice(MOUNT.length).replace(/\/+$/, '') || '/'
      if (request.method === 'GET' && tail === '/state') {
        try {
          sendJson(response, 200, { ok: true, ...(await snapshot(config)) })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message || error) })
        }
        return
      }
      if (request.method === 'POST' && (tail === '/action' || tail === '/')) {
        try {
          const body = await readJson(request)
          const result = await act(config, body)
          sendJson(response, 200, { ok: true, result, ...(await snapshot(config)) })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message || error) })
        }
        return
      }
      sendJson(response, 404, { ok: false, error: `未知路径: ${tail}` })
    })

    return () => {
      for (const dispose of registered.reverse()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'skill-mcp-manager: routes')
}

const plugin = { name, inject, apply }

export default plugin

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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
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
/** Deletions land here so a mis-click stays reversible. */
const TRASH = '.trash'
const SKILL_FILE = 'SKILL.md'
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SERVER_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** A drag-and-drop import is a bundle, not a dataset: cap it well below the HTTP body limit. */
const MAX_IMPORT_BYTES = 12 * 1024 * 1024
const MAX_IMPORT_FILES = 400
/**
 * Request body cap for `/action`.
 *
 * An import travels as base64 inside JSON, so the body is up to a third larger
 * than the bundle it carries. The limit has to follow `MAX_IMPORT_BYTES` or the
 * import cap becomes a lie: a body reader fixed at 256 KB silently rejects every
 * bundle past ~190 KB.
 */
const MAX_BODY_BYTES = Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 1024 * 1024
/** Archive noise that never belongs to a skill bundle. */
const IMPORT_SKIP = /^(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\.git\/)/

/** Active profile directory, resolved once per distinct input. */
let resolvedProfileDir
/** Cache key: the two inputs that can change which profile is active. */
let resolvedProfileKey
/** Profile directory published by the running composition, when present. */
let contextProfileDir
/** Composition context, kept so a read can refresh the workspace registry. */
let applyCtx = null

/** Absolute DSH home (`$DSH_HOME`, else `~/.dsh`). */
function dshHome() {
  return process.env.DSH_HOME || join(os.homedir(), '.dsh')
}

/** Shared agent home that also hosts skills (`$DSH_AGENTS_HOME`, else `~/.agents`). */
function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(os.homedir(), '.agents')
}

/**
 * Project directories whose skill roots the panel should mirror.
 *
 * The filesystem provider scans `<project>/.dsh/skills` and
 * `<project>/.agents/skills` relative to each agent's cwd. A Host plugin has no
 * cwd of its own, so the directories come from two honest sources instead of a
 * guess: `projectRoots` in this row's config, and the workspace registry the
 * GUI already keeps. Guessing `process.cwd()` would label unrelated roots as
 * scanned, which is exactly the lie the panel is supposed to avoid.
 *
 * The registry can hold dozens of projects; two roots each would bury the panel
 * and slow every read, so detected workspaces are capped (newest first, which is
 * the registry's order). Explicit `projectRoots` are never capped.
 */
const MAX_PROJECT_ROOTS = 12
let detectedProjectDirs = []

function configuredProjectDirs(config) {
  const out = []
  for (const dir of Array.isArray(config?.projectRoots) ? config.projectRoots : []) {
    if (typeof dir === 'string' && dir.trim()) out.push(resolve(dir))
  }
  let detected = 0
  for (const dir of detectedProjectDirs) {
    if (detected >= MAX_PROJECT_ROOTS) break
    if (out.some(existing => samePath(existing, dir))) continue
    out.push(dir)
    detected += 1
  }
  return out
}

/**
 * Refresh the workspace-registry snapshot.
 *
 * Called on mount and on every read, because projects can be added or removed
 * while the panel is open. A missing registry (older composition) is normal:
 * the configured roots still apply.
 */
function refreshProjectDirs(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return
  try {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') {
      // No registry in this composition: there is nothing detected to mirror,
      // and keeping a previous list would report roots that no longer exist.
      detectedProjectDirs = []
      return
    }
    const dirs = []
    for (const workspace of registry.list() || []) {
      const dir = workspace && typeof workspace.path === 'string' ? workspace.path : null
      if (dir) dirs.push(resolve(dir))
    }
    detectedProjectDirs = dirs
  } catch {
    /* the registry is still initializing; keep the previous snapshot */
  }
}

/**
 * Find the profile that installed this bundle.
 *
 * `DSH_PROFILE_DIR` is a shell environment value, not a Host one, and the
 * composition's `profileContext` is not always mounted, so the last resort is
 * the install itself: the profile whose `node_modules/<name>` resolves to this
 * package is the one whose patch layer must carry the managed block.
 *
 * The answer is cached, but keyed by the two inputs that decide it: a plain
 * one-shot cache would freeze the first profile it saw, which matters for the
 * test suite and for anything that switches profiles in one process.
 */
function profileDir() {
  const key = `${process.env.DSH_PROFILE_DIR || ''}\u0000${contextProfileDir || ''}`
  if (resolvedProfileKey === key) return resolvedProfileDir
  resolvedProfileKey = key
  resolvedProfileDir = findProfileDir()
  return resolvedProfileDir
}

function findProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  if (contextProfileDir) return contextProfileDir
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
  return best ? best.dir : null
}

/** The profile's user patch layer, when a profile is known. */
function patchPath() {
  const dir = profileDir()
  return dir ? join(dir, 'cordis.patch.yml') : null
}

/**
 * Where this plugin keeps its MCP definitions: inside the profile.
 *
 * The managed block is per profile, so the list that renders it has to be per
 * profile too; a shared `$DSH_HOME` file made two profiles overwrite each
 * other's servers. The old location is still read (see {@link readState}) so an
 * upgrade keeps whatever was already listed.
 */
function statePath() {
  const dir = profileDir()
  return dir
    ? join(dir, 'skill-mcp-manager', 'state.json')
    : join(dshHome(), 'skill-mcp-manager', 'state.json')
}

/** Pre-isolation location; read-only fallback for existing installs. */
function legacyStatePath() {
  return join(dshHome(), 'skill-mcp-manager', 'state.json')
}

/**
 * Skill roots in precedence order, mirroring the filesystem provider's ranks:
 * project roots, then `customSkillDirs`, then the two user homes.
 */
function skillRoots(config) {
  const roots = []
  for (const dir of configuredProjectDirs(config)) {
    roots.push({ source: 'project-dsh', dir: join(dir, '.dsh', 'skills') })
    roots.push({ source: 'project-agents', dir: join(dir, '.agents', 'skills') })
  }
  const custom = Array.isArray(config?.customSkillDirs) ? config.customSkillDirs : []
  for (const dir of custom) {
    if (typeof dir === 'string' && dir.trim()) roots.push({ source: 'custom', dir: resolve(dir) })
  }
  roots.push({ source: 'user-dsh', dir: join(dshHome(), 'skills') })
  roots.push({ source: 'user-agents', dir: join(agentsHome(), 'skills') })
  return roots
}

/** True when two paths name the same place, following junctions and symlinks. */
function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}

/** Whether a directory is one of the roots the filesystem provider scans. */
function isScannedRoot(config, dir) {
  return skillRoots(config).some(root => samePath(root.dir, dir))
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
  const targets = []
  for (const root of skillRoots(config)) {
    // A project without a skill directory has nowhere to install yet; a button
    // per workspace for a missing directory would just be noise.
    if (root.source.startsWith('project-') && !existsSync(root.dir)) continue
    targets.push({
      dir: root.dir,
      source: root.source,
      scanned: true,
      realDir: realpathOrNull(root.dir),
    })
  }
  const extra = Array.isArray(config?.extraRoots) ? config.extraRoots : []
  for (const dir of extra) {
    if (typeof dir !== 'string' || !dir.trim()) continue
    const resolved = resolve(dir)
    if (targets.some(target => samePath(target.dir, resolved))) continue
    targets.push({ dir: resolved, source: 'extra', scanned: isScannedRoot(config, resolved), realDir: realpathOrNull(resolved) })
  }
  const install = config?.installRoot ? resolve(String(config.installRoot)) : null
  if (install && !targets.some(target => samePath(target.dir, install))) {
    targets.push({ dir: install, source: 'installRoot', scanned: isScannedRoot(config, install), realDir: realpathOrNull(install) })
  }
  return targets
}

function realpathOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Resolve where an install writes: explicit request, then config, then the
 * first existing personal root.
 *
 * Project roots are deliberately last here: they are scanned first for
 * precedence, but a new skill belongs in the user's own store unless the caller
 * asked for a specific directory.
 */
function resolveInstallRoot(config, requested) {
  if (requested && String(requested).trim()) return resolve(String(requested).trim())
  if (config?.installRoot && String(config.installRoot).trim()) return resolve(String(config.installRoot).trim())
  const roots = skillRoots(config)
  const personal = roots.filter(root => root.source === 'user-dsh' || root.source === 'user-agents' || root.source === 'custom')
  const pool = personal.length > 0 ? personal : roots
  return pool.find(root => existsSync(root.dir))?.dir ?? pool[0].dir
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

/** Drop a leading UTF-8 BOM: Notepad and PowerShell 5.1 write one, and it hides `---`. */
function stripBom(text) {
  const value = String(text ?? '')
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

async function readText(path) {
  try {
    return stripBom(await fs.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Split a SKILL.md into frontmatter text and body. */
function splitFrontmatter(text) {
  const source = stripBom(text)
  if (!source.startsWith('---')) return { frontmatter: '', body: source }
  const lines = source.split(/\r?\n/)
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      return {
        frontmatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n').replace(/^\r?\n/, ''),
      }
    }
  }
  return { frontmatter: '', body: source }
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

/**
 * Read frontmatter scalars.
 *
 * Everything is collected, not just `name` and `description`: the panel also
 * needs `disable-model-invocation` / `user-invocable` to tell the difference
 * between "enabled on disk" and "visible to the model".
 */
function parseFrontmatter(frontmatter) {
  const out = {}
  const lines = String(frontmatter ?? '').split(/\r?\n/)
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
    out[key] = value
  }
  return out
}

/** Whether a frontmatter value reads as a boolean true. */
function frontmatterTrue(value) {
  return String(value ?? '').trim().toLowerCase() === 'true'
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
  const description = parsed.description || ''
  // The provider drops a skill whose frontmatter lacks name or description, and
  // honours `disable-model-invocation` by keeping it out of the model catalog.
  // Both look identical to "enabled" on disk, so the panel has to say which is
  // which instead of claiming a skill is live when the model cannot see it.
  const hidden = []
  if (!String(parsed.name || '').trim()) hidden.push('frontmatter 缺 name')
  if (!String(description).trim()) hidden.push('frontmatter 缺 description')
  if (frontmatterTrue(parsed['disable-model-invocation'])) hidden.push('disable-model-invocation: true')
  const userInvocable = String(parsed['user-invocable'] ?? '').trim().toLowerCase() !== 'false'
  // The scanned root may be a junction (a D-drive store seen through a C-drive
  // path); reporting the resolved path keeps the panel honest about where the
  // bytes actually live.
  const realPath = await fs.realpath(instructionsPath).catch(() => null)
  return {
    name: parsed.name || name,
    entry: entry.name,
    folder: stat.isDirectory(),
    description,
    path: instructionsPath,
    realPath,
    root,
    disabled,
    bytes: Buffer.byteLength(text || ''),
    modelVisible: hidden.length === 0,
    modelInvisibleReason: hidden.join('；'),
    userInvocable,
  }
}

/** Scan every root, splitting live entries from quarantined ones. */
async function listSkills(config) {
  const active = []
  const disabled = []
  const roots = []
  const scanned = new Set()
  for (const root of skillRoots(config)) {
    const exists = existsSync(root.dir)
    roots.push({ source: root.source, dir: root.dir, exists })
    if (!exists) continue
    // Two configured roots can name one store (a junction plus its target);
    // scanning both would list every skill twice.
    const real = realpathOrNull(root.dir) || resolve(root.dir)
    if (scanned.has(real)) continue
    scanned.add(real)
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
      if (described) {
        // The row carries where it was found: a project-scoped skill is only
        // visible to sessions running in that project, which the panel says out
        // loud instead of letting the badge look global.
        described.rootSource = root.source
        active.push(described)
      }
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
        if (described) {
          described.rootSource = root.source
          disabled.push(described)
        }
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

/** Every directory the panel may write into or delete from. */
function knownSkillRoots(config) {
  const dirs = skillRoots(config).map(root => resolve(root.dir))
  for (const extra of Array.isArray(config?.extraRoots) ? config.extraRoots : []) {
    if (typeof extra === 'string' && extra.trim()) dirs.push(resolve(extra))
  }
  if (config?.installRoot && String(config.installRoot).trim()) dirs.push(resolve(String(config.installRoot)))
  return [...new Set(dirs)]
}

/** Whether `target` sits strictly inside `root`, following a junction on either side. */
function isInsidePath(root, target) {
  const base = resolve(root)
  const path = resolve(target)
  const rel = relative(base, path)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
  const realRoot = realpathOrNull(base)
  const realParent = realpathOrNull(dirname(path))
  if (!realRoot || !realParent) return false
  const relReal = relative(realRoot, join(realParent, basename(path)))
  return relReal !== '' && !relReal.startsWith('..') && !isAbsolute(relReal)
}

/**
 * Known roots with aliases collapsed.
 *
 * A junction and its target are one store: reading `.trash` through both would
 * list every trashed entry twice and leave "restore" ambiguous about which root
 * owns it.
 */
function uniqueRoots(config) {
  const seen = new Set()
  const out = []
  for (const root of knownSkillRoots(config)) {
    const key = realpathOrNull(root) || resolve(root)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/**
 * Refuse a deletion that would take out a root itself or a path no root owns.
 *
 * Delete-by-path is the only door for entries outside the scanned roots, which
 * also makes it the one place a typo can wipe the whole store: the panel asks
 * for a second click, not for the path to be re-typed, so the guard belongs
 * here rather than in the browser half.
 */
function assertDeletablePath(config, target) {
  const roots = knownSkillRoots(config)
  for (const root of roots) {
    if (samePath(root, target)) {
      throw new Error(`拒绝删除根目录本身: ${root}（请删除其中的具体条目）`)
    }
    const quarantine = join(root, QUARANTINE)
    if (samePath(quarantine, target)) {
      throw new Error(`拒绝删除隔离目录本身: ${quarantine}`)
    }
  }
  if (!roots.some(root => isInsidePath(root, target))) {
    throw new Error(`路径不在任何已知 skill 根内: ${target}；允许的根: ${roots.join(' | ')}`)
  }
}

/* ------------------------------------------------------------------ trash */

/** Move a deletion into `<root>/.trash` instead of erasing it. */
function trashRoot(root) {
  return join(root, TRASH)
}

async function readTrashIndex(root) {
  const raw = await readText(join(trashRoot(root), 'index.json'))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(entry => entry && entry.id) : []
  } catch {
    return []
  }
}

async function writeTrashIndex(root, entries) {
  const dir = trashRoot(root)
  await fs.mkdir(dir, { recursive: true })
  const temp = join(dir, 'index.json.tmp')
  await fs.writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  await fs.rename(temp, join(dir, 'index.json'))
}

/**
 * Park one entry in the root's trash and record where it came from.
 *
 * The record carries the absolute origin path, so restoring a skill that was
 * disabled at deletion time puts it back under `.disabled/` rather than turning
 * it live by accident.
 */
async function moveToTrash(root, source, name) {
  const dir = trashRoot(root)
  await fs.mkdir(dir, { recursive: true })
  const base = `${Date.now().toString(36)}-${slugifyName(name)}`
  let id = base
  let suffix = 1
  while (existsSync(join(dir, id))) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  await fs.rename(source, join(dir, id))
  const entries = await readTrashIndex(root)
  const entry = { id, name, from: source, at: new Date().toISOString() }
  entries.push(entry)
  await writeTrashIndex(root, entries)
  return entry
}

/** Every trashed entry across the known roots, newest first. */
async function listTrash(config) {
  const out = []
  for (const root of uniqueRoots(config)) {
    for (const entry of await readTrashIndex(root)) {
      out.push({ ...entry, root, restorable: !existsSync(entry.from) })
    }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return out
}

/** Put a trashed entry back where it came from. */
async function restoreFromTrash(config, id) {
  const wanted = String(id || '')
  if (!wanted) throw new Error('缺少回收站条目 id')
  for (const root of uniqueRoots(config)) {
    const entries = await readTrashIndex(root)
    const entry = entries.find(item => item.id === wanted)
    if (!entry) continue
    if (existsSync(entry.from)) throw new Error(`原位置已被占用: ${entry.from}`)
    await fs.mkdir(dirname(entry.from), { recursive: true })
    await fs.rename(join(trashRoot(root), entry.id), entry.from)
    await writeTrashIndex(root, entries.filter(item => item.id !== wanted))
    return { restored: entry.name, path: entry.from, root }
  }
  throw new Error(`回收站里没有条目 "${wanted}"`)
}

/** Delete one trashed entry for good. */
async function purgeFromTrash(config, id) {
  const wanted = String(id || '')
  if (!wanted) throw new Error('缺少回收站条目 id')
  for (const root of uniqueRoots(config)) {
    const entries = await readTrashIndex(root)
    const entry = entries.find(item => item.id === wanted)
    if (!entry) continue
    await fs.rm(join(trashRoot(root), entry.id), { recursive: true, force: true })
    await writeTrashIndex(root, entries.filter(item => item.id !== wanted))
    return { purged: entry.name, id: wanted }
  }
  throw new Error(`回收站里没有条目 "${wanted}"`)
}

/**
 * Rewrite invocation-policy keys in a SKILL.md frontmatter.
 *
 * The panel's enable/disable only moves files; whether the model may call a
 * skill comes from these two keys. Editing them here is what lets the panel
 * answer "why can't the model use it" without sending the user to an editor.
 */
function editFrontmatter(text, changes) {
  const source = stripBom(text)
  const lines = source.split(/\r?\n/)
  if (lines[0].trim() !== '---') throw new Error('SKILL.md 没有 frontmatter，无法修改策略')
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) throw new Error('frontmatter 缺少闭合的 ---')
  const head = lines.slice(0, end + 1)
  const body = lines.slice(end + 1)
  for (const [key, value] of Object.entries(changes)) {
    const pattern = new RegExp(`^${key}\\s*:`)
    const index = head.findIndex((line, position) => position > 0 && pattern.test(line))
    if (value === null) {
      if (index !== -1) head.splice(index, 1)
    } else if (index !== -1) {
      head[index] = `${key}: ${value}`
    } else {
      head.splice(head.length - 1, 0, `${key}: ${value}`)
    }
  }
  return head.concat(body).join('\n')
}

/** Toggle the frontmatter keys that decide model/user visibility. */
async function setSkillPolicy(config, body) {
  const target = String(body.name || '')
  const listing = await listSkills(config)
  const skill = listing.active.concat(listing.disabled).find(item => item.name === target || item.entry === target)
  if (!skill) throw new Error(`找不到 skill "${target}"`)
  const changes = {}
  if (body.modelInvocable !== undefined) changes['disable-model-invocation'] = body.modelInvocable ? null : 'true'
  if (body.userInvocable !== undefined) changes['user-invocable'] = body.userInvocable ? null : 'false'
  if (Object.keys(changes).length === 0) throw new Error('没有指定要修改的策略')
  const text = await readText(skill.path)
  if (text === null) throw new Error(`读不到 ${skill.path}`)
  await fs.writeFile(skill.path, editFrontmatter(text, changes), 'utf8')
  const described = await describeEntry(skill.root, { name: skill.entry }, skill.disabled)
  return { name: skill.name, path: skill.path, skill: described }
}

/** Run one action over many skills; each item reports on its own. */
async function batchSkills(config, body) {
  const names = Array.isArray(body.names) ? body.names.map(name => String(name)).filter(Boolean) : []
  if (names.length === 0) throw new Error('没有选中任何条目')
  const action = String(body.action || '')
  const results = []
  for (const name of names) {
    try {
      let result
      if (action === 'disable') result = await toggleSkill(config, name, true)
      else if (action === 'enable') result = await toggleSkill(config, name, false)
      else if (action === 'delete') result = await removeSkill(config, name)
      else throw new Error(`未知的批量动作: ${action}`)
      results.push({ name, ok: true, result })
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.message || error) })
    }
  }
  return summarizeBatch('name', action, results)
}

/** Same for MCP servers. */
async function batchServers(body) {
  const names = Array.isArray(body.serverNames) ? body.serverNames.map(name => String(name)).filter(Boolean) : []
  if (names.length === 0) throw new Error('没有选中任何服务器')
  const action = String(body.action || '')
  const results = []
  for (const serverName of names) {
    try {
      if (action === 'enable') await mcpSetEnabled({ serverName, enabled: true })
      else if (action === 'disable') await mcpSetEnabled({ serverName, enabled: false })
      else if (action === 'delete') await mcpRemove({ serverName })
      else throw new Error(`未知的批量动作: ${action}`)
      results.push({ serverName, ok: true })
    } catch (error) {
      results.push({ serverName, ok: false, error: String(error?.message || error) })
    }
  }
  return summarizeBatch('serverName', action, results)
}

function summarizeBatch(key, action, results) {
  return {
    action,
    total: results.length,
    done: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  }
}

/** Delete a skill from wherever it currently sits, or by an explicit absolute path. */
async function removeSkill(config, target, explicitPath) {
  if (explicitPath && String(explicitPath).trim()) {
    const path = resolve(String(explicitPath).trim())
    const stat = await fs.stat(path).catch(() => null)
    if (!stat) throw new Error(`路径不存在: ${path}`)
    assertDeletablePath(config, path)
    const root = knownSkillRoots(config).find(candidate => isInsidePath(candidate, path))
    const entry = await moveToTrash(root, path, basename(path))
    return { name: basename(path), removedFrom: path, scanned: false, trashId: entry.id, restorable: true }
  }
  const listing = await listSkills(config)
  const hit = listing.active.concat(listing.disabled).find(skill => skill.name === target || skill.entry === target)
  if (!hit) throw new Error(`找不到 skill "${target}"`)
  // A disabled skill lives under `.disabled/`; the trash belongs to the root
  // above it and the record keeps the quarantined path as its origin.
  const root = hit.disabled ? dirname(hit.root) : hit.root
  const source = join(hit.root, hit.entry)
  const entry = await moveToTrash(root, source, hit.name)
  return {
    name: hit.name,
    removedFrom: source,
    disabled: hit.disabled,
    scanned: true,
    trashId: entry.id,
    restorable: true,
  }
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
  const scanned = isScannedRoot(config, targetRoot)

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

/* ---------------------------------------------------------------- import */

/** Turn any label into a valid skill directory name. */
function slugifyName(raw) {
  const text = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return NAME_PATTERN.test(text) ? text : (text ? text : 'imported-skill')
}

/**
 * Normalize one archive entry path.
 * @returns the path as a POSIX relative path, or null when it escapes the bundle.
 */
function normalizeEntryPath(raw) {
  const text = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!text || text.endsWith('/')) return null
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null
  const parts = text.split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0) return null
  if (parts.some(part => part === '..')) return null
  return parts.join('/')
}

/** Read a zip archive held in memory: central directory first, then per-entry inflate. */
function readZip(buffer) {
  let eocd = -1
  const stop = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('不是有效的 zip（找不到中央目录结尾）')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Error('不支持 zip64 格式')
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    const path = normalizeEntryPath(name)
    if (!path || IMPORT_SKIP.test(path)) continue
    if (localOffset + 30 > buffer.length) throw new Error(`zip 条目损坏: ${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.slice(start, start + compressedSize)
    if (method === 0) entries.push({ path, data: Buffer.from(raw) })
    else if (method === 8) entries.push({ path, data: inflateRawSync(raw) })
    else throw new Error(`不支持的 zip 压缩方式 ${method}: ${name}`)
  }
  return entries
}

/** Accept both upload shapes and produce `{ path, data }[]`. */
function importEntries(payload) {
  if (payload.zip) {
    const buffer = Buffer.from(String(payload.zip), 'base64')
    if (buffer.length === 0) throw new Error('zip 内容为空')
    if (buffer.length > MAX_IMPORT_BYTES) throw new Error('zip 超过 12 MB 上限')
    return readZip(buffer)
  }
  const files = Array.isArray(payload.files) ? payload.files : []
  if (files.length === 0) throw new Error('没有收到文件')
  const entries = []
  let total = 0
  for (const file of files) {
    const rawPath = String((file && file.path) || '').replace(/\\/g, '/')
    if (rawPath.split('/').includes('..')) throw new Error(`非法路径（含 ..）: ${rawPath}`)
    if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) throw new Error(`非法路径（绝对路径）: ${rawPath}`)
    const path = normalizeEntryPath(rawPath)
    if (!path || IMPORT_SKIP.test(path)) continue
    const data = file.base64 !== undefined
      ? Buffer.from(String(file.base64), 'base64')
      : Buffer.from(String(file.text ?? ''), 'utf8')
    total += data.length
    if (total > MAX_IMPORT_BYTES) throw new Error('导入内容超过 12 MB 上限')
    entries.push({ path, data })
    if (entries.length > MAX_IMPORT_FILES) throw new Error(`文件数超过 ${MAX_IMPORT_FILES} 上限`)
  }
  if (entries.length === 0) throw new Error('没有可导入的文件')
  return entries
}

/** Strip a single wrapper directory when the whole bundle shares it. */
function stripWrapper(entries) {
  const first = entries[0].path.split('/')[0]
  const shared = entries.every(entry => entry.path.split('/')[0] === first && entry.path.includes('/'))
  if (!shared) return { prefix: '', entries }
  return { prefix: `${first}/`, entries: entries.map(entry => ({ ...entry, path: entry.path.slice(first.length + 1) })) }
}

/** Guarantee `name` and `description` in a SKILL.md body so the provider accepts it. */
function ensureFrontmatter(text, fallbackName) {
  const source = stripBom(text)
  const split = splitFrontmatter(source)
  const parsed = parseFrontmatter(split.frontmatter)
  const name = NAME_PATTERN.test(parsed.name || '') ? parsed.name : slugifyName(parsed.name || fallbackName)
  let frontmatter = split.frontmatter
  let patched = false
  if (!parsed.name) {
    frontmatter = `name: ${name}\n${frontmatter}`.trimEnd()
    patched = true
  }
  let description = parsed.description
  if (!description || !description.trim()) {
    description = `导入的 skill（原文件未提供描述）: ${name}`
    frontmatter = `${frontmatter}\ndescription: ${yamlScalar(description)}`.trim()
    patched = true
  }
  const body = split.body
  const text2 = patched ? `---\n${frontmatter}\n---\n${body.replace(/^\r?\n/, '')}` : source
  return { text: text2, name, description, patched }
}

/**
 * Install a dropped bundle (folder listing or zip).
 *
 * The bundle is inspected before anything is written: it must carry a
 * `SKILL.md`, its name must resolve to a valid directory name, and an existing
 * target is only replaced when the caller asks for it.
 */
async function installImported(config, payload) {
  const entries = stripWrapper(importEntries(payload))
  const skillEntry = entries.entries.find(entry => entry.path === SKILL_FILE)
  if (!skillEntry) {
    const found = entries.entries.find(entry => entry.path.toLowerCase().endsWith('/skill.md'))
    throw new Error(found
      ? `SKILL.md 必须在包根目录，当前在 ${found.path}`
      : '压缩包/文件夹里没有 SKILL.md')
  }
  const raw = stripBom(skillEntry.data.toString('utf8'))
  const ensured = ensureFrontmatter(raw, payload.name || basename(entries.prefix || 'imported-skill'))
  const requested = payload.name ? slugifyName(payload.name) : ensured.name
  const entry = NAME_PATTERN.test(requested) ? requested : slugifyName(requested)

  const targetRoot = resolveInstallRoot(config, payload.root)
  await fs.mkdir(targetRoot, { recursive: true })
  const destination = join(targetRoot, entry)
  const existed = existsSync(destination)
  if (existed && payload.overwrite !== true) {
    throw new Error(`目标已存在: ${destination}（勾选覆盖或先删除）`)
  }
  if (existed) await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(destination, { recursive: true })

  const written = []
  for (const file of entries.entries) {
    const relative = file.path
    if (!relative) continue
    const absolute = resolve(join(destination, relative))
    if (absolute !== destination && !absolute.startsWith(`${destination}${sep}`)) {
      throw new Error(`非法路径: ${relative}`)
    }
    await fs.mkdir(dirname(absolute), { recursive: true })
    const data = relative === SKILL_FILE ? Buffer.from(ensured.text, 'utf8') : file.data
    await fs.writeFile(absolute, data)
    written.push(relative)
  }

  const scanned = isScannedRoot(config, targetRoot)
  const described = await describeEntry(targetRoot, { name: entry }, false)
  const warnings = []
  if (ensured.patched) warnings.push('SKILL.md 缺少 name 或 description，已自动补齐，请在文件里改成真实描述。')
  if (!scanned) warnings.push(`安装目录 ${targetRoot} 不在扫描根内，skill 不会被加载。`)
  return {
    installed: entry,
    path: destination,
    root: targetRoot,
    scanned,
    replaced: existed,
    files: written,
    skill: described,
    warnings,
  }
}

/* -------------------------------------------------------------------- MCP */

async function readState() {
  // The profile-scoped file wins; the shared pre-isolation file is the fallback
  // for an install that predates the move, and stops mattering after the first
  // write (writeState always targets the profile).
  const primary = await readText(statePath())
  const raw = primary === null && statePath() !== legacyStatePath()
    ? await readText(legacyStatePath())
    : primary
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
/**
 * Cheap structural checks before a patch write.
 *
 * The panel edits the file the whole composition loads, so a malformed write is
 * not a local mistake — it takes the GUI down with it. Tabs and duplicated
 * markers are the two shapes this renderer can actually produce, and both are
 * rejected here rather than discovered at the next boot.
 */
function assertPatchShape(text) {
  const starts = text.split(BLOCK_START).length - 1
  const ends = text.split(BLOCK_END).length - 1
  if (starts > 1 || ends > 1) throw new Error('受管段落标记重复，已拒绝写入')
  if (starts !== ends) throw new Error('受管段落标记不配对，已拒绝写入')
  if (/^\t/m.test(text)) throw new Error('patch 含制表符缩进（YAML 不接受），已拒绝写入')
}

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
  assertPatchShape(body)
  // Keep the previous revision next to the file: if anything downstream rejects
  // the new layer, the user has a verbatim copy to put back.
  if (text !== '') await fs.writeFile(`${path}.bak`, text, 'utf8')
  const temp = `${path}.${process.pid}.tmp`
  await fs.writeFile(temp, body, 'utf8')
  await fs.rename(temp, path)
  const written = await readText(path)
  if (written !== body) {
    await fs.writeFile(path, text, 'utf8')
    throw new Error('patch 写入校验失败，已回滚到上一版')
  }
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

/** Server names the managed block currently declares (enabled rows only). */
function blockServerNames(patch) {
  if (!patch) return []
  const lines = patch.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === BLOCK_START)
  if (start === -1) return []
  const end = lines.findIndex((line, index) => index > start && line.trim() === BLOCK_END)
  const names = []
  for (const line of lines.slice(start + 1, end === -1 ? lines.length : end)) {
    const match = /^\s*serverName:\s*'(.*)'\s*$/.exec(line)
    if (match) names.push(match[1].replace(/''/g, "'"))
  }
  return names
}

/**
 * Live MCP tools grouped by server, or null when the tool registry is absent.
 *
 * `dsh-mcp-client` registers every tool under `mcp__<serverName>__<tool>`, so the
 * registry view is the only honest evidence available to a panel: if a server's
 * namespace is empty, its process is not connected — regardless of what the
 * patch says.
 */
function mcpToolIndex() {
  try {
    const tools = applyCtx && typeof applyCtx.get === 'function' ? applyCtx.get('tools') : null
    if (!tools || typeof tools.view !== 'function') return null
    const view = tools.view()
    if (!view || !(view.visible instanceof Map)) return null
    const index = new Map()
    for (const name of view.visible.keys()) {
      const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(String(name))
      if (!match) continue
      const server = match[1]
      if (!index.has(server)) index.set(server, [])
      index.get(server).push(match[2])
    }
    return index
  } catch {
    return null
  }
}

async function mcpList() {
  const state = await readState()
  const path = patchPath()
  const patch = path ? await readText(path) : null
  const expected = state.mcp.filter(server => server.enabled !== false).map(server => server.serverName)
  const inBlock = blockServerNames(patch)
  const toolIndex = mcpToolIndex()
  const servers = state.mcp.map(server => {
    const tools = toolIndex ? (toolIndex.get(server.serverName) || []).slice().sort() : []
    const status = server.enabled === false
      ? 'disabled'
      : toolIndex === null
        ? 'unknown'
        : tools.length > 0
          ? 'connected'
          : 'disconnected'
    return { ...server, status, tools }
  })
  return {
    servers,
    statePath: statePath(),
    patchPath: path,
    patchPresent: patch !== null,
    blockPresent: patch ? patch.includes(BLOCK_START) : false,
    // A hand-edited patch, a half-finished write, or a second profile can leave
    // the state file and the block disagreeing; reporting it lets the panel warn
    // instead of quietly showing servers that will not load.
    blockServers: inBlock,
    consistent: expected.length === inBlock.length && expected.every(name => inBlock.includes(name)),
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

/**
 * Reject writes that did not come from this panel.
 *
 * These routes are destructive and the host server answers on localhost with no
 * CORS handling, so a plain cross-site form/fetch would otherwise be able to
 * delete skills. A JSON content type forces a preflight for browsers; the
 * Origin and Sec-Fetch-Site checks close the "simple request" hole for clients
 * that skip it. Scripts (curl, tests) send no Origin and stay welcome.
 */
function assertWritableRequest(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase()
  if (!type.includes('application/json')) throw new Error('请求必须是 application/json')
  const site = request.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') throw new Error('拒绝跨站请求')
  const origin = request.headers.origin
  if (!origin) return
  const host = request.headers.host
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = ''
  }
  if (!host || originHost !== host) throw new Error('拒绝跨站请求')
}

async function readJson(request, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)} MB）`)
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

async function snapshot(config) {
  refreshProjectDirs(applyCtx)
  const [skills, mcp] = await Promise.all([listSkills(config), mcpList()])
  skills.trash = await listTrash(config)
  return {
    build: 'v13',
    now: Date.now(),
    dshHome: dshHome(),
    agentsHome: agentsHome(),
    profileDir: profileDir(),
    projectRoots: configuredProjectDirs(config),
    projectRootsDetected: detectedProjectDirs.length,
    installRoot: resolveInstallRoot(config),
    installTargets: installTargets(config),
    mcpRoot: mcpRoot(config),
    skills,
    mcp,
  }
}

/**
 * Serialize mutations.
 *
 * Every action is a read-modify-write over `state.json` plus the managed block,
 * and the block is found by scanning the patch text. Two overlapping requests
 * can therefore drop a row (both read the same head, the second write wins), so
 * the route takes one action at a time.
 */
let mutationTail = Promise.resolve()

function withMutationLock(task) {
  const run = mutationTail.then(task, task)
  mutationTail = run.then(() => undefined, () => undefined)
  return run
}

async function dispatch(config, body) {
  const domain = String(body.domain || '')
  const op = String(body.op || '')
  if (domain === 'skill') {
    if (op === 'disable') return toggleSkill(config, String(body.name), true)
    if (op === 'enable') return toggleSkill(config, String(body.name), false)
    if (op === 'delete') return removeSkill(config, String(body.name || ''), body.path)
    if (op === 'install') return installSkill(config, body)
    if (op === 'import') return installImported(config, body)
    if (op === 'restore') return restoreFromTrash(config, body.id)
    if (op === 'purge') return purgeFromTrash(config, body.id)
    if (op === 'policy') return setSkillPolicy(config, body)
    if (op === 'batch') return batchSkills(config, body)
    throw new Error(`未知的 skill 操作: ${op}`)
  }
  if (domain === 'mcp') {
    if (op === 'add') return mcpAdd(config, body)
    if (op === 'update') return mcpUpdate(config, body)
    if (op === 'enable') return mcpSetEnabled({ serverName: body.serverName, enabled: true })
    if (op === 'disable') return mcpSetEnabled({ serverName: body.serverName, enabled: false })
    if (op === 'delete') return mcpRemove(body)
    if (op === 'batch') return batchServers(body)
    throw new Error(`未知的 mcp 操作: ${op}`)
  }
  throw new Error(`未知的管理域: ${domain}`)
}

/** Entry point used by the route: every mutation runs through the lock. */
function act(config, body) {
  return withMutationLock(() => dispatch(config, body))
}

export function apply(ctx, config) {
  applyCtx = ctx
  try {
    const profile = ctx.get('profileContext')
    if (profile && typeof profile.dir === 'string' && profile.dir) contextProfileDir = profile.dir
  } catch {
    /* the composition may not mount a profile context */
  }
  refreshProjectDirs(ctx)

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
          assertWritableRequest(request)
        } catch (error) {
          sendJson(response, 403, { ok: false, error: String(error?.message || error) })
          return
        }
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
      if (applyCtx === ctx) applyCtx = null
    }
  }, 'skill-mcp-manager: routes')
}

/**
 * Helpers the test suite exercises directly.
 *
 * Exposing them here keeps the tests on the code the plugin actually runs,
 * instead of on a copy that can drift.
 */
export const __test__ = {
  splitFrontmatter,
  parseFrontmatter,
  ensureFrontmatter,
  normalizeEntryPath,
  stripWrapper,
  slugifyName,
  readZip,
  stripBom,
  isInsidePath,
  assertDeletablePath,
  knownSkillRoots,
  uniqueRoots,
  blockServerNames,
  configuredProjectDirs,
  skillRoots,
  editFrontmatter,
  assertPatchShape,
  MAX_IMPORT_BYTES,
  MAX_BODY_BYTES,
  BLOCK_START,
  BLOCK_END,
}

const plugin = { name, inject, apply }

export default plugin

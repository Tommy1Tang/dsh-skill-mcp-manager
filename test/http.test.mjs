/**
 * End-to-end tests for the HTTP surface.
 *
 * The Host half is loaded with a stub `webServer` that records the routes it
 * registers, then those handlers are exposed through a real `node:http` server so
 * the tests exercise request parsing, the body limit, and the JSON contract the
 * panel uses.
 *
 * Run with: node --test test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import plugin from '../lib/index.js'
import { __test__ as T } from '../lib/index.js'
import { makeZip } from '../test-support/zip.mjs'

const sandbox = mkdtempSync(join(os.tmpdir(), 'smm-http-'))
process.env.DSH_HOME = join(sandbox, 'dsh')
process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')
process.env.DSH_PROFILE_DIR = join(sandbox, 'profile')

const patchFile = join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')
const foreignPatch = '# hand written comment\n- id: foreign\n  config:\n    keep: true\n'
const config = {
  installRoot: join(sandbox, 'install'),
  mcpRoot: join(sandbox, 'mcp'),
  customSkillDirs: [join(sandbox, 'custom')],
}

await fs.mkdir(process.env.DSH_PROFILE_DIR, { recursive: true })
await fs.writeFile(patchFile, foreignPatch, 'utf8')

const routes = []
let workspaceRegistry = null
let toolView = null
const ctx = {
  get: name => {
    if (name === 'workspaceRegistry') return workspaceRegistry
    if (name === 'tools') return toolView ? { view: () => toolView } : undefined
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
}

plugin.apply(ctx, config)

const server = http.createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname
  const exact = routes.find(route => route.kind === 'exact' && route.path === path)
  if (exact) {
    void exact.handler(request, response)
    return
  }
  const prefix = routes.find(route => route.kind === 'prefix' && path.startsWith(route.path))
  if (prefix) {
    void prefix.handler(request, response)
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"ok":false,"error":"no route"}')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const MOUNT = '/skill-mcp-manager'

test.after(() => new Promise(resolve => server.close(resolve)))

async function getState() {
  const response = await fetch(`${base}${MOUNT}/state`)
  return { status: response.status, body: await response.json() }
}

async function act(payload) {
  const response = await fetch(`${base}${MOUNT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

async function readPatch() {
  return fs.readFile(patchFile, 'utf8')
}

test('GET /state reports roots, install target, and patch location', async () => {
  const { status, body } = await getState()
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.installRoot, config.installRoot)
  assert.equal(body.mcpRoot, config.mcpRoot)
  assert.equal(body.mcp.patchPath, patchFile)
  assert.equal(body.mcp.consistent, true)
  const sources = body.skills.roots.map(root => root.source)
  assert.deepEqual(sources, ['custom', 'user-dsh', 'user-agents'])
})

test('import keeps a BOM-authored frontmatter intact', async () => {
  const skill = '---\r\nname: bom-skill\r\ndescription: BOM authored.\r\n---\r\n\r\n# body\r\n'
  const zip = makeZip([{ path: 'bom-main/SKILL.md', data: `\uFEFF${skill}` }])
  const { status, body } = await act({
    domain: 'skill',
    op: 'import',
    zip: zip.toString('base64'),
    root: config.installRoot,
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.result.installed, 'bom-skill')
  assert.equal(body.result.replaced, false)
  const warnings = body.result.warnings.join(' ')
  assert.ok(!warnings.includes('缺少 name'), `unexpected placeholder warning: ${warnings}`)

  const written = await fs.readFile(join(config.installRoot, 'bom-skill', 'SKILL.md'), 'utf8')
  assert.ok(!written.startsWith('\uFEFF'), 'BOM must not survive the import')
  assert.ok(!written.includes('导入的 skill'), 'description must not be replaced by the placeholder')
  assert.equal(written.match(/^---$/gm).length, 2, 'exactly one frontmatter block')
  assert.match(written, /description: BOM authored\./)
})

test('import accepts a bundle whose body exceeds the old 256 KB cap', async () => {
  const asset = Buffer.alloc(700 * 1024, 0x41)
  const zip = makeZip([
    { path: 'big-skill/SKILL.md', data: '---\nname: big-skill\ndescription: Carries a large asset.\n---\n' },
    { path: 'big-skill/assets/blob.bin', data: asset },
  ])
  const body = JSON.stringify({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root: config.installRoot })
  assert.ok(Buffer.byteLength(body) > 256 * 1024, 'the request body has to beat the old limit to prove anything')
  assert.ok(Buffer.byteLength(body) < T.MAX_BODY_BYTES)

  const response = await fetch(`${base}${MOUNT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.result.installed, 'big-skill')
  const written = await fs.readFile(join(config.installRoot, 'big-skill', 'assets', 'blob.bin'))
  assert.equal(written.length, asset.length)
})

test('a body past the new cap is still refused with a readable reason', async () => {
  const oversized = 'x'.repeat(T.MAX_BODY_BYTES + 1024)
  const response = await fetch(`${base}${MOUNT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'skill', op: 'import', files: [], padding: oversized }),
  })
  const payload = await response.json()
  assert.equal(response.status, 400)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /请求体过大/)
})

test('delete by path refuses roots, quarantine, and foreign paths', async () => {
  await fs.mkdir(join(sandbox, 'outside', 'anything'), { recursive: true })

  const root = await act({ domain: 'skill', op: 'delete', path: config.installRoot })
  assert.equal(root.status, 400)
  assert.match(root.body.error, /拒绝删除根目录本身/)

  const quarantine = join(config.installRoot, '.disabled')
  await fs.mkdir(quarantine, { recursive: true })
  const parked = await act({ domain: 'skill', op: 'delete', path: quarantine })
  assert.equal(parked.status, 400)
  assert.match(parked.body.error, /拒绝删除隔离目录本身/)

  const foreign = await act({ domain: 'skill', op: 'delete', path: join(sandbox, 'outside', 'anything') })
  assert.equal(foreign.status, 400)
  assert.match(foreign.body.error, /不在任何已知 skill 根内/)

  const victim = join(config.installRoot, 'victim-skill')
  await fs.mkdir(victim, { recursive: true })
  const okay = await act({ domain: 'skill', op: 'delete', path: victim })
  assert.equal(okay.status, 200)
  assert.equal(okay.body.ok, true)
  await assert.rejects(fs.stat(victim))
})

test('disable/enable moves a skill in and out of .disabled', async () => {
  const customRoot = config.customSkillDirs[0]
  const zip = makeZip([
    { path: 'toggle-skill/SKILL.md', data: '---\nname: toggle-skill\ndescription: Toggles.\n---\n' },
  ])
  const imported = await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root: customRoot })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.result.scanned, true)

  const disabled = await act({ domain: 'skill', op: 'disable', name: 'toggle-skill' })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.result.disabled, true)
  assert.ok(disabled.body.skills.disabled.some(skill => skill.name === 'toggle-skill'))
  const parked = await fs.stat(join(customRoot, '.disabled', 'toggle-skill'))
  assert.ok(parked.isDirectory())

  const enabled = await act({ domain: 'skill', op: 'enable', name: 'toggle-skill' })
  assert.equal(enabled.status, 200)
  assert.ok(enabled.body.skills.active.some(skill => skill.name === 'toggle-skill'))

  const removed = await act({ domain: 'skill', op: 'delete', name: 'toggle-skill' })
  assert.equal(removed.status, 200)
  await assert.rejects(fs.stat(join(customRoot, 'toggle-skill')))
})

test('a skill the model cannot see is reported as such', async () => {
  const customRoot = config.customSkillDirs[0]
  const zip = makeZip([
    {
      path: 'hidden-skill/SKILL.md',
      data: '---\nname: hidden-skill\ndescription: Only reachable by the user.\ndisable-model-invocation: true\n---\n',
    },
  ])
  const imported = await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root: customRoot })
  assert.equal(imported.status, 200)
  const listed = imported.body.skills.active.find(skill => skill.name === 'hidden-skill')
  assert.ok(listed, 'the panel still lists it')
  assert.equal(listed.modelVisible, false)
  assert.match(listed.modelInvisibleReason, /disable-model-invocation/)
  assert.equal(listed.userInvocable, true)
  await act({ domain: 'skill', op: 'delete', name: 'hidden-skill' })
})

test('MCP add/enable/disable/delete rewrites only the managed block', async () => {
  const added = await act({
    domain: 'mcp',
    op: 'add',
    serverName: 'probe-mcp',
    transport: 'stdio',
    command: 'node',
    args: 'server.mjs',
    env: 'PROBE=1',
  })
  assert.equal(added.status, 200)
  assert.equal(added.body.result.server.serverName, 'probe-mcp')
  assert.equal(added.body.mcp.consistent, true)
  assert.deepEqual(added.body.mcp.blockServers, ['probe-mcp'])

  let patch = await readPatch()
  assert.ok(patch.includes('- id: foreign'), 'foreign rows must survive')
  assert.ok(patch.includes(T.BLOCK_START))
  assert.ok(patch.includes("serverName: 'probe-mcp'"))
  assert.ok(patch.includes("cwd: '"), 'stdio servers get a managed cwd')

  const disabled = await act({ domain: 'mcp', op: 'disable', serverName: 'probe-mcp' })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.mcp.consistent, true)
  assert.deepEqual(disabled.body.mcp.blockServers, [])
  patch = await readPatch()
  assert.ok(patch.includes('已禁用（不进入组合）: probe-mcp'))
  assert.ok(!patch.includes("serverName: 'probe-mcp'"))

  const enabled = await act({ domain: 'mcp', op: 'enable', serverName: 'probe-mcp' })
  assert.equal(enabled.status, 200)
  patch = await readPatch()
  assert.ok(patch.includes("serverName: 'probe-mcp'"))

  const removed = await act({ domain: 'mcp', op: 'delete', serverName: 'probe-mcp' })
  assert.equal(removed.status, 200)
  patch = await readPatch()
  assert.ok(!patch.includes(T.BLOCK_START), 'the block disappears when the last server goes')
  assert.equal(patch.trim(), foreignPatch.trim())
})

test('state that drifts from the patch is reported instead of hidden', async () => {
  await act({
    domain: 'mcp',
    op: 'add',
    serverName: 'drift-mcp',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:9/mcp',
  })
  // Simulate a hand edit (or another profile) removing the managed block.
  await fs.writeFile(patchFile, foreignPatch, 'utf8')

  const { body } = await getState()
  assert.equal(body.mcp.servers.length, 1)
  assert.equal(body.mcp.blockServers.length, 0)
  assert.equal(body.mcp.consistent, false)

  const cleaned = await act({ domain: 'mcp', op: 'delete', serverName: 'drift-mcp' })
  assert.equal(cleaned.status, 200)
  assert.equal(cleaned.body.mcp.consistent, true)
  const patch = await readPatch()
  assert.equal(patch.trim(), foreignPatch.trim())
})

test('update rewrites a server in place and renders headers', async () => {
  const added = await act({
    domain: 'mcp',
    op: 'add',
    serverName: 'http-mcp',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:3100/mcp',
    headers: 'Authorization=Bearer first\nX-Tenant=alpha',
  })
  assert.equal(added.status, 200)
  let patch = await readPatch()
  assert.ok(patch.includes("url: 'http://127.0.0.1:3100/mcp'"))
  assert.ok(patch.includes('headers:'))
  assert.ok(patch.includes("Authorization: 'Bearer first'"))

  const updated = await act({
    domain: 'mcp',
    op: 'update',
    serverName: 'http-mcp',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:3200/mcp',
    headers: 'Authorization=Bearer second',
  })
  assert.equal(updated.status, 200)
  patch = await readPatch()
  assert.ok(!patch.includes('3100'), 'the old URL must not linger')
  assert.ok(patch.includes("url: 'http://127.0.0.1:3200/mcp'"))
  assert.ok(patch.includes("Authorization: 'Bearer second'"))
  assert.ok(!patch.includes('X-Tenant'), 'replaced headers must not linger')

  const stdio = await act({ domain: 'mcp', op: 'add', serverName: 'edit-stdio', transport: 'stdio', command: 'node', args: 'a.mjs' })
  assert.equal(stdio.status, 200)
  const stdioUpdate = await act({
    domain: 'mcp',
    op: 'update',
    serverName: 'edit-stdio',
    transport: 'stdio',
    command: 'node',
    args: 'b.mjs\n--flag',
    env: 'MODE=edit',
  })
  assert.equal(stdioUpdate.status, 200)
  patch = await readPatch()
  assert.ok(patch.includes("- 'b.mjs'"))
  assert.ok(patch.includes("- '--flag'"))
  assert.ok(patch.includes("MODE: 'edit'"))

  const missing = await act({ domain: 'mcp', op: 'update', serverName: 'nope', transport: 'stdio', command: 'node' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /找不到 MCP 服务器/)

  await act({ domain: 'mcp', op: 'delete', serverName: 'http-mcp' })
  await act({ domain: 'mcp', op: 'delete', serverName: 'edit-stdio' })
})

test('project skill roots are scanned when the workspace registry lists them', async () => {
  const projectDir = join(sandbox, 'project-one')
  await fs.mkdir(join(projectDir, '.dsh', 'skills', 'proj-skill'), { recursive: true })
  await fs.writeFile(
    join(projectDir, '.dsh', 'skills', 'proj-skill', 'SKILL.md'),
    '---\nname: proj-skill\ndescription: Project scoped.\n---\n',
    'utf8',
  )
  await fs.mkdir(join(projectDir, '.agents', 'skills', 'proj-agent-skill'), { recursive: true })
  await fs.writeFile(
    join(projectDir, '.agents', 'skills', 'proj-agent-skill', 'SKILL.md'),
    '---\nname: proj-agent-skill\ndescription: Project agents scoped.\n---\n',
    'utf8',
  )

  workspaceRegistry = { list: () => [{ path: projectDir }] }
  try {
    const { body } = await getState()
    assert.ok(body.projectRoots.includes(projectDir))
    const sources = body.skills.roots.map(root => root.source)
    assert.ok(sources.includes('project-dsh'))
    assert.ok(sources.includes('project-agents'))
    const names = body.skills.active.map(skill => skill.name)
    assert.ok(names.includes('proj-skill'), 'project .dsh/skills is scanned')
    assert.ok(names.includes('proj-agent-skill'), 'project .agents/skills is scanned')
    assert.equal(body.skills.active.find(skill => skill.name === 'proj-skill').rootSource, 'project-dsh')

    const targets = body.installTargets.map(target => `${target.source}:${target.dir}`)
    assert.ok(targets.includes(`project-dsh:${join(projectDir, '.dsh', 'skills')}`))

    const disabled = await act({ domain: 'skill', op: 'disable', name: 'proj-skill' })
    assert.equal(disabled.status, 200)
    assert.ok((await fs.stat(join(projectDir, '.dsh', 'skills', '.disabled', 'proj-skill'))).isDirectory())

    const enabled = await act({ domain: 'skill', op: 'enable', name: 'proj-skill' })
    assert.equal(enabled.status, 200)

    const removed = await act({ domain: 'skill', op: 'delete', name: 'proj-skill' })
    assert.equal(removed.status, 200)
    await assert.rejects(fs.stat(join(projectDir, '.dsh', 'skills', 'proj-skill')))
  } finally {
    workspaceRegistry = null
  }
})

test('MCP state is per profile', async () => {
  const profileA = process.env.DSH_PROFILE_DIR
  const profileB = join(sandbox, 'profile-b')
  await fs.mkdir(profileB, { recursive: true })
  await fs.writeFile(join(profileB, 'cordis.patch.yml'), foreignPatch, 'utf8')

  const addedA = await act({ domain: 'mcp', op: 'add', serverName: 'only-a', transport: 'stdio', command: 'node' })
  assert.equal(addedA.status, 200)
  assert.equal(addedA.body.mcp.statePath, join(profileA, 'skill-mcp-manager', 'state.json'))

  process.env.DSH_PROFILE_DIR = profileB
  try {
    const emptyB = await getState()
    assert.deepEqual(emptyB.body.mcp.servers, [], 'profile B must not inherit profile A servers')
    assert.equal(emptyB.body.mcp.statePath, join(profileB, 'skill-mcp-manager', 'state.json'))

    const addedB = await act({ domain: 'mcp', op: 'add', serverName: 'only-b', transport: 'stdio', command: 'node' })
    assert.equal(addedB.status, 200)
    const patchB = await fs.readFile(join(profileB, 'cordis.patch.yml'), 'utf8')
    assert.ok(patchB.includes("serverName: 'only-b'"))
    assert.ok(!patchB.includes('only-a'))
  } finally {
    process.env.DSH_PROFILE_DIR = profileA
  }

  const back = await getState()
  assert.deepEqual(back.body.mcp.servers.map(server => server.serverName), ['only-a'])
  const patchA = await readPatch()
  assert.ok(patchA.includes("serverName: 'only-a'"))
  assert.ok(!patchA.includes('only-b'))

  await act({ domain: 'mcp', op: 'delete', serverName: 'only-a' })
  process.env.DSH_PROFILE_DIR = profileB
  await act({ domain: 'mcp', op: 'delete', serverName: 'only-b' })
  process.env.DSH_PROFILE_DIR = profileA
})

test('detected project roots are capped, explicit ones are not', async () => {
  const dirs = Array.from({ length: 20 }, (_, index) => join(sandbox, `many-${index}`))
  workspaceRegistry = { list: () => dirs.map(path => ({ path })) }
  try {
    const { body } = await getState()
    assert.equal(body.projectRootsDetected, 20)
    assert.equal(body.projectRoots.length, 12, 'detected roots are capped')
    assert.deepEqual(body.projectRoots, dirs.slice(0, 12))
    assert.ok(
      !body.installTargets.some(target => target.dir.includes('many-')),
      'a project without a skill directory is not offered as an install target',
    )
  } finally {
    workspaceRegistry = null
  }
  // With the registry gone the detected list clears instead of going stale.
  const after = await getState()
  assert.deepEqual(after.body.projectRoots, [])
  assert.equal(after.body.projectRootsDetected, 0)
})

test('writes are refused unless they come from this panel', async () => {
  const plain = await fetch(`${base}${MOUNT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ domain: 'skill', op: 'enable', name: 'nope' }),
  })
  assert.equal(plain.status, 403)
  assert.match((await plain.json()).error, /application\/json/)

  const crossSite = await fetch(`${base}${MOUNT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ domain: 'skill', op: 'enable', name: 'nope' }),
  })
  assert.equal(crossSite.status, 403)
  assert.match((await crossSite.json()).error, /拒绝跨站请求/)

  // Same origin passes the gate and fails later on the missing skill instead.
  const sameSite = await fetch(`${base}${MOUNT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ domain: 'skill', op: 'enable', name: 'nope' }),
  })
  assert.equal(sameSite.status, 400)
})

test('delete parks a skill in the trash and can restore or purge it', async () => {
  const root = config.customSkillDirs[0]
  const zip = makeZip([
    { path: 'trash-me/SKILL.md', data: '---\nname: trash-me\ndescription: Temporary.\n---\n' },
  ])
  const imported = await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root })
  assert.equal(imported.status, 200)

  const removed = await act({ domain: 'skill', op: 'delete', name: 'trash-me' })
  assert.equal(removed.status, 200)
  const trashId = removed.body.result.trashId
  assert.ok(trashId, 'delete must report the trash id')
  assert.ok(removed.body.skills.trash.some(entry => entry.name === 'trash-me'))
  await assert.rejects(fs.stat(join(root, 'trash-me')))

  const restored = await act({ domain: 'skill', op: 'restore', id: trashId })
  assert.equal(restored.status, 200)
  assert.ok((await fs.stat(join(root, 'trash-me'))).isDirectory())
  assert.ok(!restored.body.skills.trash.some(entry => entry.id === trashId))

  // A disabled skill is restored into `.disabled/`, not turned live.
  await act({ domain: 'skill', op: 'disable', name: 'trash-me' })
  const parked = await act({ domain: 'skill', op: 'delete', name: 'trash-me' })
  const parkedRestore = await act({ domain: 'skill', op: 'restore', id: parked.body.result.trashId })
  assert.equal(parkedRestore.status, 200)
  assert.ok((await fs.stat(join(root, '.disabled', 'trash-me'))).isDirectory())
  assert.ok(!parkedRestore.body.skills.active.some(skill => skill.name === 'trash-me'))

  const again = await act({ domain: 'skill', op: 'delete', name: 'trash-me' })
  const purged = await act({ domain: 'skill', op: 'purge', id: again.body.result.trashId })
  assert.equal(purged.status, 200)
  assert.ok(!purged.body.skills.trash.some(entry => entry.id === again.body.result.trashId))
  await assert.rejects(fs.stat(join(root, '.trash', again.body.result.trashId)))
})

test('batch actions report per-item results', async () => {
  const root = config.customSkillDirs[0]
  for (const name of ['batch-a', 'batch-b']) {
    const zip = makeZip([{ path: `${name}/SKILL.md`, data: `---\nname: ${name}\ndescription: Batch.\n---\n` }])
    await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root })
  }

  const disabled = await act({ domain: 'skill', op: 'batch', action: 'disable', names: ['batch-a', 'batch-b', 'missing-one'] })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.result.done, 2)
  assert.equal(disabled.body.result.failed, 1)
  assert.equal(disabled.body.result.results.find(item => item.name === 'missing-one').ok, false)

  const enabled = await act({ domain: 'skill', op: 'batch', action: 'enable', names: ['batch-a', 'batch-b'] })
  assert.equal(enabled.body.result.done, 2)

  const removed = await act({ domain: 'skill', op: 'batch', action: 'delete', names: ['batch-a', 'batch-b'] })
  assert.equal(removed.body.result.done, 2)
  await assert.rejects(fs.stat(join(root, 'batch-a')))
})

test('policy toggles the invocation flag and nothing else', async () => {
  const root = config.customSkillDirs[0]
  const zip = makeZip([{
    path: 'flag-skill/SKILL.md',
    data: '---\nname: flag-skill\ndescription: Flagged.\ndisable-model-invocation: true\n---\n\n# body\n',
  }])
  await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root })

  const opened = await act({ domain: 'skill', op: 'policy', name: 'flag-skill', modelInvocable: true })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.result.skill.modelVisible, true)
  let text = await fs.readFile(join(root, 'flag-skill', 'SKILL.md'), 'utf8')
  assert.ok(!text.includes('disable-model-invocation'))
  assert.match(text, /description: Flagged\./)
  assert.match(text, /# body/)

  const closed = await act({ domain: 'skill', op: 'policy', name: 'flag-skill', modelInvocable: false })
  assert.equal(closed.status, 200)
  assert.equal(closed.body.result.skill.modelVisible, false)
  text = await fs.readFile(join(root, 'flag-skill', 'SKILL.md'), 'utf8')
  assert.match(text, /disable-model-invocation: true/)
  assert.match(text, /description: Flagged\./)

  await act({ domain: 'skill', op: 'delete', name: 'flag-skill' })
})

test('MCP rows report live connection state and support batch actions', async () => {
  await act({ domain: 'mcp', op: 'add', serverName: 'status-mcp', transport: 'stdio', command: 'node' })

  toolView = {
    visible: new Map([
      ['mcp__status-mcp__ping', {}],
      ['mcp__other-mcp__x', {}],
    ]),
  }
  try {
    const live = await getState()
    const row = live.body.mcp.servers.find(server => server.serverName === 'status-mcp')
    assert.equal(row.status, 'connected')
    assert.deepEqual(row.tools, ['ping'])

    toolView = { visible: new Map() }
    const down = await getState()
    assert.equal(down.body.mcp.servers.find(server => server.serverName === 'status-mcp').status, 'disconnected')
  } finally {
    toolView = null
  }
  const unknown = await getState()
  assert.equal(unknown.body.mcp.servers.find(server => server.serverName === 'status-mcp').status, 'unknown')

  const batch = await act({ domain: 'mcp', op: 'batch', action: 'delete', serverNames: ['status-mcp', 'nope'] })
  assert.equal(batch.status, 200)
  assert.equal(batch.body.result.done, 1)
  assert.equal(batch.body.result.failed, 1)
})

test('a patch rewrite keeps the previous revision beside the file', async () => {
  await act({ domain: 'mcp', op: 'add', serverName: 'backup-mcp', transport: 'stdio', command: 'node' })
  const backup = await fs.readFile(`${patchFile}.bak`, 'utf8')
  assert.match(backup, /hand written comment/)
  assert.ok(!backup.includes('backup-mcp'), 'the backup holds the revision from before this write')
  await act({ domain: 'mcp', op: 'delete', serverName: 'backup-mcp' })
})

test('a junction alias does not duplicate listings or trash entries', async () => {
  const root = config.customSkillDirs[0]
  const link = join(sandbox, 'custom-alias')
  await fs.symlink(root, link, 'junction')
  config.customSkillDirs.push(link)
  try {
    const zip = makeZip([
      { path: 'alias-skill/SKILL.md', data: '---\nname: alias-skill\ndescription: Alias check.\n---\n' },
    ])
    await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root })

    const listed = await getState()
    assert.equal(
      listed.body.skills.active.filter(skill => skill.name === 'alias-skill').length,
      1,
      'one store must be scanned once, not once per alias',
    )

    const removed = await act({ domain: 'skill', op: 'delete', name: 'alias-skill' })
    assert.equal(
      removed.body.skills.trash.filter(entry => entry.name === 'alias-skill').length,
      1,
      'the trash index is shared by the alias, so it must not be listed twice',
    )

    const restored = await act({ domain: 'skill', op: 'restore', id: removed.body.result.trashId })
    assert.equal(restored.status, 200)
    assert.ok((await fs.stat(join(root, 'alias-skill'))).isDirectory())

    const again = await act({ domain: 'skill', op: 'delete', name: 'alias-skill' })
    const purged = await act({ domain: 'skill', op: 'purge', id: again.body.result.trashId })
    assert.equal(purged.status, 200)
  } finally {
    config.customSkillDirs.pop()
    await fs.unlink(link)
  }
})

test('detail returns the body, files, and resolved references', async () => {
  const root = config.customSkillDirs[0]
  const zip = makeZip([
    {
      path: 'detail-skill/SKILL.md',
      data: '---\nname: detail-skill\ndescription: Detail check.\n---\n\nCall the Skill tool with "missing-skill".\n',
    },
    { path: 'detail-skill/notes.md', data: 'notes\n' },
  ])
  await act({ domain: 'skill', op: 'import', zip: zip.toString('base64'), root })

  const detail = await act({ domain: 'skill', op: 'detail', name: 'detail-skill' })
  assert.equal(detail.status, 200)
  const result = detail.body.result
  assert.match(result.body, /Call the Skill tool with "missing-skill"/)
  assert.ok(result.files.some(file => file.path === 'SKILL.md'))
  assert.ok(result.files.some(file => file.path === 'notes.md'))
  const ref = result.references.find(item => item.name === 'missing-skill')
  assert.equal(ref.installed, false)

  const missing = await act({ domain: 'skill', op: 'detail', name: 'nope' })
  assert.equal(missing.status, 400)
  await act({ domain: 'skill', op: 'delete', name: 'detail-skill' })
})

test('the snapshot offers project install targets even before they exist', async () => {
  const projectDir = join(sandbox, 'project-targets')
  workspaceRegistry = { list: () => [{ path: projectDir }] }
  try {
    const { body } = await getState()
    const targets = body.projectInstallTargets
    assert.ok(targets.some(target => target.dir === join(projectDir, '.dsh', 'skills') && target.exists === false))
    assert.ok(targets.some(target => target.dir === join(projectDir, '.agents', 'skills') && target.exists === false))

    const installed = await act({
      domain: 'skill',
      op: 'install',
      name: 'project-born-skill',
      description: 'Installed into a project root.',
      root: join(projectDir, '.dsh', 'skills'),
    })
    assert.equal(installed.status, 200)
    assert.equal(installed.body.result.scanned, true)
    assert.ok((await fs.stat(join(projectDir, '.dsh', 'skills', 'project-born-skill', 'SKILL.md'))).isFile())

    const after = await getState()
    assert.ok(after.body.projectInstallTargets.some(target => target.dir === join(projectDir, '.dsh', 'skills') && target.exists === true))
    await act({ domain: 'skill', op: 'delete', name: 'project-born-skill' })
  } finally {
    workspaceRegistry = null
  }
})

test('env values written as loader expressions stay unquoted in the patch', async () => {
  await act({
    domain: 'mcp',
    op: 'add',
    serverName: 'secret-mcp',
    transport: 'stdio',
    command: 'node',
    env: 'TOKEN=!!js process.env.MCP_TOKEN\nPLAIN=hello',
  })
  const patch = await readPatch()
  assert.match(patch, /TOKEN: !!js process\.env\.MCP_TOKEN/)
  assert.ok(!patch.includes("'!!js process.env.MCP_TOKEN'"), 'a loader expression must not be quoted')
  assert.match(patch, /PLAIN: 'hello'/)
  await act({ domain: 'mcp', op: 'delete', serverName: 'secret-mcp' })
})

test('unknown domains and operations answer 400 with a reason', async () => {
  const noDomain = await act({ op: 'nope' })
  assert.equal(noDomain.status, 400)
  assert.match(noDomain.body.error, /未知的管理域/)

  const noOp = await act({ domain: 'skill', op: 'nope' })
  assert.equal(noOp.status, 400)
  assert.match(noOp.body.error, /未知的 skill 操作/)
})

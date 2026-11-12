/**
 * Unit tests for the Host half's pure helpers.
 *
 * Run with: node --test test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { __test__ as T } from '../lib/index.js'
import { makeZip } from '../test-support/zip.mjs'

const sandbox = mkdtempSync(join(os.tmpdir(), 'smm-units-'))
process.env.DSH_HOME = join(sandbox, 'dsh')
process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')

test('stripBom drops a leading UTF-8 BOM only', () => {
  assert.equal(T.stripBom('\uFEFF---\nname: x\n'), '---\nname: x\n')
  assert.equal(T.stripBom('---\nname: x\n'), '---\nname: x\n')
  assert.equal(T.stripBom(''), '')
  assert.equal(T.stripBom(null), '')
  // A BOM inside the body is content, not a marker.
  assert.equal(T.stripBom('body\uFEFFtail'), 'body\uFEFFtail')
})

test('splitFrontmatter reads frontmatter behind a BOM', () => {
  const text = '\uFEFF---\nname: bom-skill\ndescription: BOM authored.\n---\n\n# body\n'
  const split = T.splitFrontmatter(text)
  assert.match(split.frontmatter, /name: bom-skill/)
  assert.match(split.frontmatter, /description: BOM authored\./)
  assert.equal(split.body.trim(), '# body')
})

test('splitFrontmatter falls back to body-only text', () => {
  const split = T.splitFrontmatter('# just markdown\n')
  assert.equal(split.frontmatter, '')
  assert.equal(split.body, '# just markdown\n')
})

test('parseFrontmatter keeps the keys that gate discovery', () => {
  const parsed = T.parseFrontmatter([
    'name: grill-me',
    'description: A relentless interview.',
    'disable-model-invocation: true',
    "user-invocable: 'false'",
    'description-long: >-',
    '  wrapped text',
  ].join('\n'))
  assert.equal(parsed.name, 'grill-me')
  assert.equal(parsed.description, 'A relentless interview.')
  assert.equal(parsed['disable-model-invocation'], 'true')
  assert.equal(parsed['user-invocable'], 'false')
  assert.equal(parsed['description-long'], 'wrapped text')
})

test('ensureFrontmatter leaves a complete BOM-authored file untouched', () => {
  const text = '\uFEFF---\nname: bom-skill\ndescription: BOM authored.\n---\n\n# body\n'
  const ensured = T.ensureFrontmatter(text, 'fallback-name')
  assert.equal(ensured.patched, false)
  assert.equal(ensured.name, 'bom-skill')
  assert.equal(ensured.description, 'BOM authored.')
  assert.equal(ensured.text, '---\nname: bom-skill\ndescription: BOM authored.\n---\n\n# body\n')
  assert.equal(ensured.text.split('\n---').length - 1, 1, 'exactly one frontmatter fence pair')
})

test('ensureFrontmatter fills the gap when description is missing', () => {
  const ensured = T.ensureFrontmatter('---\nname: partial-skill\n---\n\n# body\n', 'partial-skill')
  assert.equal(ensured.patched, true)
  assert.equal(ensured.name, 'partial-skill')
  assert.match(ensured.text, /description: '导入的 skill/)
  assert.match(ensured.text, /# body/)
})

test('ensureFrontmatter derives a slug when name and description are absent', () => {
  const ensured = T.ensureFrontmatter('# Body only\n', 'My Imported Skill')
  assert.equal(ensured.patched, true)
  assert.equal(ensured.name, 'my-imported-skill')
  assert.match(ensured.text, /^---\nname: my-imported-skill\ndescription:/)
})

test('normalizeEntryPath rejects anything that escapes the bundle', () => {
  assert.equal(T.normalizeEntryPath('./a/b.md'), 'a/b.md')
  assert.equal(T.normalizeEntryPath('a\\b.md'), 'a/b.md')
  assert.equal(T.normalizeEntryPath('dir/'), null)
  assert.equal(T.normalizeEntryPath(''), null)
  assert.equal(T.normalizeEntryPath('../evil.md'), null)
  assert.equal(T.normalizeEntryPath('a/../../evil.md'), null)
  assert.equal(T.normalizeEntryPath('C:\\Windows\\evil.md'), null)
  assert.equal(T.normalizeEntryPath('/etc/passwd'), null)
})

test('slugifyName always produces an installable directory name', () => {
  assert.equal(T.slugifyName('My Skill!'), 'my-skill')
  assert.equal(T.slugifyName('  spaced__out  '), 'spaced-out')
  assert.equal(T.slugifyName(''), 'imported-skill')
  assert.equal(T.slugifyName('---'), 'imported-skill')
})

test('readZip reads stored and deflated entries and skips archive noise', () => {
  const zip = makeZip([
    { path: 'bundle-main/SKILL.md', data: '---\nname: z\n---\n' },
    { path: 'bundle-main/scripts/run.js', data: 'console.log(1)\n' },
    { path: '__MACOSX/._SKILL.md', data: 'junk' },
    { path: '.DS_Store', data: 'junk' },
    { path: '.git/config', data: 'junk' },
  ], { deflate: true })

  const entries = T.readZip(zip)
  assert.deepEqual(entries.map(entry => entry.path), ['bundle-main/SKILL.md', 'bundle-main/scripts/run.js'])
  assert.equal(entries[1].data.toString('utf8'), 'console.log(1)\n')
})

test('readZip accepts stored entries and rejects a body without a central directory', () => {
  const stored = T.readZip(makeZip([{ path: 'SKILL.md', data: 'x' }]))
  assert.equal(stored.length, 1)
  assert.throws(() => T.readZip(Buffer.from('not a zip at all')), /找不到中央目录结尾/)
})

test('stripWrapper removes exactly one wrapper directory', () => {
  const zip = makeZip([
    { path: 'repo-main/SKILL.md', data: 'x' },
    { path: 'repo-main/references/a.md', data: 'y' },
  ])
  const stripped = T.stripWrapper(T.readZip(zip))
  assert.equal(stripped.prefix, 'repo-main/')
  assert.deepEqual(stripped.entries.map(entry => entry.path), ['SKILL.md', 'references/a.md'])

  const flat = T.stripWrapper([{ path: 'SKILL.md', data: Buffer.from('x') }])
  assert.equal(flat.prefix, '')
})

test('isInsidePath is strict about the root itself and about siblings', () => {
  const base = join(sandbox, 'base')
  assert.equal(T.isInsidePath(base, join(base, 'child')), true)
  assert.equal(T.isInsidePath(base, join(base, 'a', 'b')), true)
  assert.equal(T.isInsidePath(base, base), false)
  assert.equal(T.isInsidePath(base, join(base, '..', 'sibling')), false)
})

test('assertDeletablePath protects roots, quarantine, and foreign paths', () => {
  const config = { installRoot: join(sandbox, 'install'), customSkillDirs: [] }
  assert.throws(
    () => T.assertDeletablePath(config, join(sandbox, 'install')),
    /拒绝删除根目录本身/,
  )
  assert.throws(
    () => T.assertDeletablePath(config, join(sandbox, 'install', '.disabled')),
    /拒绝删除隔离目录本身/,
  )
  assert.throws(
    () => T.assertDeletablePath(config, join(sandbox, 'elsewhere', 'my-skill')),
    /不在任何已知 skill 根内/,
  )
  assert.doesNotThrow(() => T.assertDeletablePath(config, join(sandbox, 'install', 'my-skill')))
})

test('knownSkillRoots covers the defaults, custom roots, and installRoot', () => {
  const config = { installRoot: join(sandbox, 'install'), customSkillDirs: [join(sandbox, 'custom')] }
  const roots = T.knownSkillRoots(config)
  assert.ok(roots.some(root => root === join(sandbox, 'dsh', 'skills')))
  assert.ok(roots.some(root => root === join(sandbox, 'agents', 'skills')))
  assert.ok(roots.some(root => root === join(sandbox, 'custom')))
  assert.ok(roots.some(root => root === join(sandbox, 'install')))
})

test('blockServerNames reads only the managed block', () => {
  const patch = [
    '# hand written',
    T.BLOCK_START,
    '- insert:',
    '    - id: mcp-demo',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    "        serverName: 'demo'",
    "        transport: 'stdio'",
    T.BLOCK_END,
    '# tail',
  ].join('\n')
  assert.deepEqual(T.blockServerNames(patch), ['demo'])
  assert.deepEqual(T.blockServerNames(''), [])
  assert.deepEqual(T.blockServerNames('# nothing here'), [])
})

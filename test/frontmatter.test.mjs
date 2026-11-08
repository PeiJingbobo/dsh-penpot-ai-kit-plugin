import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter, toSkillFields } from '../lib/frontmatter.mjs'
import { PACKAGE_ROOT } from '../lib/provider.mjs'

const skillsRoot = join(PACKAGE_ROOT, 'skills')
const skillDirs = readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)

test('parses all 14 vendored SKILL.md files', () => {
  assert.equal(skillDirs.length, 14)
  for (const dir of skillDirs) {
    const raw = readFileSync(join(skillsRoot, dir, 'SKILL.md'), 'utf8')
    const parsed = parseFrontmatter(raw)
    assert.notEqual(parsed, null, `${dir} frontmatter`)
    assert.equal(parsed.data.name, dir)
    assert.equal(typeof parsed.data.description, 'string')
    assert.ok(parsed.data.description.length > 100, `${dir} description is long`)
    assert.ok(Array.isArray(parsed.data.requires), `${dir} requires is an array`)
    assert.ok(parsed.data.requires.length > 0)
    assert.ok(Array.isArray(parsed.data.audiences), `${dir} audiences is an array`)
    assert.equal(typeof parsed.data.version, 'string')
    assert.equal(parsed.data['disable-model-invocation'], false)
    assert.ok(parsed.body.startsWith('#'), `${dir} body starts with a heading`)
  }
})

test('keeps extra frontmatter keys as metadata', () => {
  const raw = readFileSync(join(skillsRoot, 'penpot-audit-tokens', 'SKILL.md'), 'utf8')
  const fields = toSkillFields(parseFrontmatter(raw).data, 'penpot-audit-tokens')
  assert.equal(fields.name, 'penpot-audit-tokens')
  assert.equal(fields.invocation.modelInvocable, true)
  assert.equal(fields.invocation.userInvocable, true)
  assert.equal(fields.metadata.version, '0.2.1')
  assert.equal(fields.metadata['mode-default'], 'suggest')
  assert.ok(Array.isArray(fields.metadata.requires))
  assert.ok(fields.metadata.requires.includes('shared/penpot-mcp-tool-reference.md'))
})

test('handles quoted colons, apostrophes, inline arrays and block sequences', () => {
  const parsed = parseFrontmatter([
    '---',
    'name: demo-skill',
    'description: "Build: a thing with a colon, an em dash — and \'quotes\'."',
    "single: 'it''s fine'",
    'audiences: [design-system, product-designer]',
    'requires:',
    '  - shared/a.md',
    '  - shared/b.md',
    'flag: false',
    '---',
    '',
    '# Body',
    '',
    'Text.',
  ].join('\n'))
  assert.equal(parsed.data.description, 'Build: a thing with a colon, an em dash — and \'quotes\'.')
  assert.equal(parsed.data.single, "it's fine")
  assert.deepEqual(parsed.data.audiences, ['design-system', 'product-designer'])
  assert.deepEqual(parsed.data.requires, ['shared/a.md', 'shared/b.md'])
  assert.equal(parsed.data.flag, false)
  assert.equal(parsed.body, '# Body\n\nText.')
})

test('returns null for missing or malformed frontmatter', () => {
  assert.equal(parseFrontmatter('# no frontmatter'), null)
  assert.equal(parseFrontmatter('---\nname: x\n'), null)
  assert.equal(parseFrontmatter(' ---\nname: x\n---\n'), null)
})

test('falls back to the directory name when name is invalid', () => {
  const fields = toSkillFields({ name: 'Not Valid!', description: 'x' }, 'fallback-name')
  assert.equal(fields.name, 'fallback-name')
})

test('parses the local penpot-setup skill', () => {
  const raw = readFileSync(join(PACKAGE_ROOT, 'skills-local', 'penpot-setup', 'SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed.data.name, 'penpot-setup')
  assert.match(parsed.body, /penpot_kit_status/)
  assert.match(parsed.body, /\.dsh\/penpot-ai-kit\/config\.json/)
})

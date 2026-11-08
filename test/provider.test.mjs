import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PACKAGE_ROOT,
  PenpotKitSkillProvider,
  providerPaths,
  rewriteSkillRelativePaths,
  SETUP_SKILL_NAME,
} from '../lib/provider.mjs'
import { parseFrontmatter } from '../lib/frontmatter.mjs'

const PATHS = providerPaths()
const config = { providerName: 'test-provider', source: 'test', rank: 650, ...PATHS }

function fakeGate(available) {
  return { isAvailable: () => available }
}

function makeProvider(available) {
  const control = { signal: new AbortController().signal, invalidate() {} }
  return new PenpotKitSkillProvider({ logger: { warn() {} } }, control, config, fakeGate(available))
}

test('closed gate exposes exactly penpot-setup', async () => {
  const provider = makeProvider(false)
  try {
    const list = await provider.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, SETUP_SKILL_NAME)
  } finally {
    await provider.dispose()
  }
})

test('open gate exposes the 14 upstream skills plus penpot-setup', async () => {
  const provider = makeProvider(true)
  try {
    const list = await provider.list()
    assert.equal(list.length, 15)
    const names = list.map(skill => skill.name)
    assert.equal(names[0], 'penpot-anti-slop')
    assert.ok(names.includes('penpot-audit-tokens'))
    assert.ok(names.includes('penpot-router'))
    assert.ok(names.includes(SETUP_SKILL_NAME))
    assert.equal(list.filter(skill => skill.source === 'test').length, 15)
  } finally {
    await provider.dispose()
  }
})

test('get() gates vendored skills but always serves penpot-setup', async () => {
  const open = makeProvider(true)
  const list = await open.list()
  const auditCandidate = list.find(skill => skill.name === 'penpot-audit-tokens')
  const setupCandidate = list.find(skill => skill.name === SETUP_SKILL_NAME)
  await open.dispose()

  const closed = makeProvider(false)
  try {
    assert.equal(await closed.get(auditCandidate), undefined)
    const setup = await closed.get(setupCandidate)
    assert.equal(setup.name, SETUP_SKILL_NAME)
    assert.equal(setup.resourceBase.kind, 'directory')
    assert.equal(setup.resourceBase.path, join(PATHS.localSkillsDir, SETUP_SKILL_NAME))
    assert.match(setup.content, /penpot_kit_status/)
  } finally {
    await closed.dispose()
  }
})

test('vendored skills publish the kit root as resourceBase so shared/ resolves', async () => {
  const provider = makeProvider(true)
  try {
    const list = await provider.list()
    for (const summary of list.filter(skill => skill.name !== SETUP_SKILL_NAME)) {
      const skill = await provider.get(summary)
      assert.equal(skill.resourceBase.kind, 'directory')
      assert.equal(skill.resourceBase.path, PACKAGE_ROOT, `${skill.name} resourceBase`)

      const requires = skill.metadata?.requires ?? []
      assert.ok(Array.isArray(requires) && requires.length > 0, `${skill.name} requires`)
      for (const rel of requires) {
        assert.ok(existsSync(join(PACKAGE_ROOT, rel)), `${skill.name} requires ${rel}`)
      }

      for (const match of skill.content.matchAll(/(?:^|[\s(`])(shared\/[A-Za-z0-9._/-]+)/g)) {
        const rel = match[1].replace(/[.,;:)\]]+$/, '')
        assert.ok(existsSync(join(PACKAGE_ROOT, rel)), `${skill.name} body references ${rel}`)
      }

      // Loadable skill-local references are rebased onto the kit root. Bare
      // directory labels such as `**references/**` and unvendored repo tooling
      // under scripts/dev/ are not file references and stay as prose.
      assert.doesNotMatch(
        skill.content,
        /(^|[^A-Za-z0-9_./-])(?:references|scripts)\/[A-Za-z0-9._-]+\.(?:md|json|js|mjs)\b/m,
        `${skill.name} has a bare skill-local file reference`,
      )
      if (skill.content.includes('skills/' + skill.name + '/references/')) {
        const match = skill.content.match(/skills\/[^\s)`]+references\/[^\s)`]+/)
        assert.ok(existsSync(join(PACKAGE_ROOT, match[0])), `${skill.name} rebased reference ${match[0]}`)
      }
    }
  } finally {
    await provider.dispose()
  }
})

test('rewriteSkillRelativePaths is idempotent and leaves other roots alone', () => {
  const body = 'See references/01.md, scripts/run.js, shared/x.md and https://e.com/references/y.md.'
  const once = rewriteSkillRelativePaths(body, 'penpot-audit-tokens')
  assert.equal(once, 'See skills/penpot-audit-tokens/references/01.md, skills/penpot-audit-tokens/scripts/run.js, shared/x.md and https://e.com/references/y.md.')
  assert.equal(rewriteSkillRelativePaths(once, 'penpot-audit-tokens'), once)
})

test('every vendored skill frontmatter is parseable and descriptions are non-empty', () => {
  const found = readFileSync(join(PACKAGE_ROOT, 'skills', 'penpot-router', 'SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(found)
  assert.equal(parsed.data.name, 'penpot-router')
  assert.ok(parsed.data.description.length > 100)
  assert.ok(Array.isArray(parsed.data.requires))
  assert.equal(parsed.data.requires.length, 6)
})

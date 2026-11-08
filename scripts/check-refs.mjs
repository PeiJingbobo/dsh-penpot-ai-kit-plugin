#!/usr/bin/env node
/**
 * Reference integrity for the vendored kit.
 *
 * Upstream SKILL.md files reference two roots at once:
 *   - shared/…, policies/…, workflows/…, prompts/… → kit root
 *   - references/…, scripts/…                      → the skill's own directory
 * Both are validated here, plus every frontmatter `requires:` entry, every
 * skill directory's SKILL.md, and skills.json ↔ skills/ agreement.
 *
 * Only tokens that look like files (known extension) are treated as references,
 * so prose like "across all skills/workflows" is not a false positive.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOTS = ['skills', 'skills-local', 'shared', 'policies', 'workflows', 'prompts']
const ROOT_PREFIXES = ['skills/', 'shared/', 'policies/', 'workflows/', 'prompts/']
const SKILL_LOCAL_PREFIXES = ['references/', 'scripts/']
const FILE_EXTENSION = /\.(?:md|markdown|json|js|mjs|cjs|ts|tsx|css|html|svg|txt|ya?ml)$/
const TOKEN_PATTERN = /(^|[^\w./-])((?:skills|shared|policies|workflows|prompts|references|scripts)\/[A-Za-z0-9._~%+/-]+)/g

const problems = []
const checked = []

function fail(message) {
  problems.push(message)
}

function walk(root, out = []) {
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(md|json|js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const relativeToPackage = file => relative(packageRoot, file).split(sep).join('/')

function skillDirFor(relPath) {
  const parts = relPath.split('/')
  return (parts[0] === 'skills' || parts[0] === 'skills-local') && parts.length >= 3
    ? parts.slice(0, 2).join('/')
    : null
}

// Skill-local references appear in shared/ and workflows/ docs too, addressed
// by their skill-directory name (`references/…`, `scripts/…`). Resolve those
// against every skill directory, not just the containing file's.
const allSkillDirs = (() => {
  const dirs = []
  for (const base of ['skills', 'skills-local']) {
    const root = join(packageRoot, base)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${base}/${entry.name}`)
    }
  }
  return dirs
})()

function checkReference(rawRef, containingFile) {
  const ref = rawRef.replace(/[.,;:)\]]+$/, '').replace(/[#?].*$/, '')
  if (!FILE_EXTENSION.test(ref)) return
  // Repo-development tooling is not vendored by design (content-only kit).
  if (ref.startsWith('scripts/dev/')) return

  const relPath = relativeToPackage(containingFile)
  const skillDir = skillDirFor(relPath)
  const candidates = []

  if (SKILL_LOCAL_PREFIXES.some(prefix => ref.startsWith(prefix))) {
    if (skillDir !== null) candidates.push(join(packageRoot, skillDir, ref))
    for (const dir of allSkillDirs) candidates.push(join(packageRoot, dir, ref))
    candidates.push(join(packageRoot, ref))
  } else if (ROOT_PREFIXES.some(prefix => ref.startsWith(prefix))) {
    candidates.push(join(packageRoot, ref))
  } else {
    return
  }

  checked.push(ref)
  if (candidates.some(candidate => existsSync(candidate))) return
  fail(`${relPath}: missing ${ref} (looked in ${[...new Set(candidates)].map(relativeToPackage).join(', ')})`)
}

// 1. Every directory under skills/ and skills-local/ is a complete skill.
for (const root of ['skills', 'skills-local']) {
  const full = join(packageRoot, root)
  if (!existsSync(full)) { fail(`${root}/ is missing`); continue }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(full, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) fail(`${root}/${entry.name}/SKILL.md is missing`)
  }
}

// 2. Scan every text file for relative references.
for (const root of SCAN_ROOTS) {
  for (const file of walk(join(packageRoot, root))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(TOKEN_PATTERN)) checkReference(match[2], file)
  }
}

// 3. frontmatter `requires:` must resolve against the kit root.
for (const root of ['skills', 'skills-local']) {
  const full = join(packageRoot, root)
  if (!existsSync(full)) continue
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(full, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const text = readFileSync(skillFile, 'utf8')
    const frontmatter = text.startsWith('---') ? text.slice(4, text.indexOf('\n---', 3)) : ''
    const block = frontmatter.match(/^requires:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m)
    if (block === null) continue
    for (const line of block[1].split('\n')) {
      const match = line.match(/^\s*-\s+(.+)$/)
      if (match === null) continue
      const ref = match[1].trim().replace(/^["']|["']$/g, '')
      checked.push(`requires:${ref}`)
      if (!existsSync(join(packageRoot, ref))) {
        fail(`${root}/${entry.name}/SKILL.md: requires missing ${ref}`)
      }
    }
  }
}

// 4. skills.json agrees with the directory tree.
const skillsJsonPath = join(packageRoot, 'skills.json')
if (existsSync(skillsJsonPath)) {
  try {
    const manifest = JSON.parse(readFileSync(skillsJsonPath, 'utf8'))
    const listed = new Set((manifest.skills ?? []).map(skill => skill.path))
    for (const skill of manifest.skills ?? []) {
      if (!existsSync(join(packageRoot, skill.path))) fail(`skills.json lists missing path ${skill.path}`)
    }
    for (const entry of readdirSync(join(packageRoot, 'skills'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const expected = `skills/${entry.name}/SKILL.md`
      if (!listed.has(expected)) fail(`${expected} is not listed in skills.json`)
    }
  } catch (error) {
    fail(`cannot parse skills.json: ${error?.message ?? error}`)
  }
}

if (problems.length > 0) {
  console.error(`check-refs: ${problems.length} problem(s) in ${checked.length} checked reference(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-refs: OK — ${checked.length} references resolved across ${SCAN_ROOTS.length} roots`)

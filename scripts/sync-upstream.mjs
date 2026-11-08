#!/usr/bin/env node
/**
 * Sync the vendored penpot-ai-kit snapshot from upstream.
 *
 *   node scripts/sync-upstream.mjs [options]
 *
 * Options:
 *   --repo <url>    upstream git URL or local path (default: UPSTREAM.json repo)
 *   --ref <branch>  branch/tag/sha to track             (default: main)
 *   --from <path>   local upstream checkout (skips git)
 *   --check         report drift only; exit 1 when behind
 *
 * Vendored paths: skills/ shared/ policies/ workflows/ prompts/ skills.json.
 * Also refreshes LICENSE-PENPOT and records
 * { repo, ref, commit, upstreamVersion, syncedAt } in UPSTREAM.json.
 *
 * Versioning: package.json tracks the upstream release. A local revision
 * suffix (`0.5.1-dsh.1`) survives while upstream stays at the same version and
 * is replaced by the plain upstream version when upstream advances.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(packageRoot, 'UPSTREAM.json')
const cacheDir = join(packageRoot, '.upstream', 'penpot-ai-kit')
const VENDORED_DIRS = ['skills', 'shared', 'policies', 'workflows', 'prompts']
const VENDORED_FILES = ['skills.json']
const DEFAULT_REPO = 'https://github.com/penpot/penpot-ai-kit'

function fail(message) {
  console.error(`sync-upstream: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--repo' || token === '--ref' || token === '--from') {
      const value = argv[i + 1]
      if (value === undefined) fail(`${token} requires a value`)
      args[token.slice(2)] = value
      i += 1
    } else if (token === '--check') {
      args.check = true
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      args._.push(token)
    }
  }
  return args
}

function run(command, cmdArgs) {
  const result = spawnSync(command, cmdArgs, { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    fail(`${command} ${cmdArgs.join(' ')} failed:\n${result.stderr || result.stdout || String(result.error ?? '(no output)')}`)
  }
  return result.stdout.trim()
}

function walk(root, base = root) {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

/** Structural + byte comparison of one upstream path against the vendored one. */
function comparePath(source, target, relPath) {
  const sourcePath = join(source, relPath)
  const targetPath = join(target, relPath)
  if (!existsSync(targetPath)) {
    return { missingLocal: existsSync(sourcePath) ? [relPath] : [], changed: [], orphaned: [] }
  }
  if (!statSync(sourcePath).isDirectory()) {
    const identical = readFileSync(sourcePath).equals(readFileSync(targetPath))
    return { missingLocal: [], changed: identical ? [] : [relPath], orphaned: [] }
  }

  const sourceFiles = walk(sourcePath)
  const targetFiles = walk(targetPath)
  const sourceSet = new Set(sourceFiles)
  const targetSet = new Set(targetFiles)
  return {
    missingLocal: sourceFiles.filter(file => !targetSet.has(file)).map(file => `${relPath}/${file}`),
    changed: sourceFiles
      .filter(file => targetSet.has(file))
      .filter(file => !readFileSync(join(sourcePath, file)).equals(readFileSync(join(targetPath, file))))
      .map(file => `${relPath}/${file}`),
    orphaned: targetFiles.filter(file => !sourceSet.has(file)).map(file => `${relPath}/${file}`),
  }
}

function diffSnapshot(source) {
  const report = { missingLocal: [], changed: [], orphaned: [] }
  for (const relPath of [...VENDORED_DIRS, ...VENDORED_FILES]) {
    const result = comparePath(source, packageRoot, relPath)
    report.missingLocal.push(...result.missingLocal)
    report.changed.push(...result.changed)
    report.orphaned.push(...result.orphaned)
  }
  return report
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('Usage: node scripts/sync-upstream.mjs [--repo <url|path>] [--ref <branch>] [--from <checkout>] [--check]')
  process.exit(0)
}

let manifest = {}
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`cannot parse UPSTREAM.json: ${error?.message ?? error}`)
  }
}
const repo = args.repo ?? manifest.repo ?? DEFAULT_REPO
const sourceSpec = args.from ?? repo
const ref = args.ref ?? manifest.ref ?? 'main'
if (typeof repo !== 'string' || repo.length === 0) fail('no upstream repo configured; pass --repo <url>')

function prepareSource() {
  const looksLocal = /^[./~]/.test(sourceSpec) || (!sourceSpec.includes(':') && existsSync(sourceSpec))
  if (looksLocal) {
    const source = resolve(sourceSpec.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    if (!existsSync(join(source, 'skills'))) fail(`local checkout "${source}" has no skills/ directory`)
    const probe = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    return { source, commit: probe.status === 0 ? probe.stdout.trim() : '' }
  }
  if (!existsSync(cacheDir)) {
    mkdirSync(dirname(cacheDir), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', ref, sourceSpec, cacheDir])
  } else {
    run('git', ['-C', cacheDir, 'fetch', '--depth', '1', 'origin', ref])
    run('git', ['-C', cacheDir, 'reset', '--hard', 'FETCH_HEAD'])
  }
  const head = run('git', ['-C', cacheDir, 'rev-parse', 'HEAD'])
  return { source: cacheDir, commit: head }
}

const { source, commit } = prepareSource()

if (args.check) {
  const report = diffSnapshot(source)
  const total = report.missingLocal.length + report.changed.length + report.orphaned.length
  if (total === 0) {
    console.log(`sync-upstream: up to date with ${repo}${commit ? `@${commit.slice(0, 12)}` : ''}`)
    process.exit(0)
  }
  console.error(`sync-upstream: behind upstream ${repo}${commit ? `@${commit.slice(0, 12)}` : ''} (${total} difference(s)):`)
  for (const [label, paths] of [['missing', report.missingLocal], ['changed', report.changed], ['orphaned', report.orphaned]]) {
    for (const path of paths.slice(0, 20)) console.error(`  ${label}: ${path}`)
    if (paths.length > 20) console.error(`  ${label}: … ${paths.length - 20} more`)
  }
  process.exit(1)
}

for (const dir of VENDORED_DIRS) {
  const from = join(source, dir)
  const to = join(packageRoot, dir)
  if (!existsSync(from)) fail(`upstream ${dir}/ is missing in ${source}`)
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}
for (const file of VENDORED_FILES) {
  const from = join(source, file)
  if (!existsSync(from)) fail(`upstream ${file} is missing in ${source}`)
  cpSync(from, join(packageRoot, file))
}
if (existsSync(join(source, 'LICENSE'))) {
  cpSync(join(source, 'LICENSE'), join(packageRoot, 'LICENSE-PENPOT'))
}

function readUpstreamVersion(dir) {
  try {
    const version = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8')).version
    if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) return version
  } catch { /* fall through to package.json */ }
  try {
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  } catch {
    return null
  }
}

const upstreamVersion = readUpstreamVersion(source)
if (upstreamVersion !== null && upstreamVersion !== manifest.upstreamVersion) {
  const pkgPath = join(packageRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = upstreamVersion // one plugin release per upstream release; local -dsh.N suffix ends here
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`sync-upstream: package.json version -> ${upstreamVersion}`)
}

const nextManifest = {
  repo,
  ref,
  commit,
  ...(upstreamVersion !== null ? { upstreamVersion } : {}),
  syncedAt: new Date().toISOString(),
}
const facts = ({ repo: r, ref: f, commit: c, upstreamVersion: v }) => JSON.stringify([r, f, c, v ?? null])
if (!existsSync(manifestPath) || facts(nextManifest) !== facts(manifest)) {
  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
} else {
  console.log('sync-upstream: UPSTREAM.json unchanged (tracking facts identical)')
}

const skillCount = readdirSync(join(packageRoot, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).length
console.log(`sync-upstream: vendored ${skillCount} skills from ${repo}${commit ? `@${commit.slice(0, 12)}` : ''} (ref ${ref})`)
if (upstreamVersion !== null) console.log(`sync-upstream: tracking upstream version ${upstreamVersion}`)
console.log('sync-upstream: a running harness reloads the catalog automatically (the provider watches skills/).')

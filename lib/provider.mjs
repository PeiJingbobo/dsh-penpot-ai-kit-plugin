#!/usr/bin/env node
/**
 * Skill provider for the vendored penpot-ai-kit library.
 *
 * The gate is enforced here, at the catalog layer: when no verified Penpot MCP
 * is available, `list()` exposes exactly one skill (`penpot-setup`) and the 14
 * upstream skills do not exist for the model. `get()` re-checks the gate so a
 * stale catalog cannot load a gated skill either.
 *
 * Resource resolution: every upstream body mixes two roots —
 *   - `shared/…`, `policies/…`, `workflows/…`, `prompts/…` → kit root
 *   - `references/…`, `scripts/…`                      → the skill's own dir
 * A skill definition has ONE `resourceBase`, so we publish the kit root and
 * rewrite the skill-local prefixes to `skills/<name>/…` at load time. The
 * vendored bytes stay byte-identical to upstream; only the rendered body is
 * rebased.
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, watch as fsWatch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, toSkillFields, SKILL_NAME } from './frontmatter.mjs'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_SKILLS_DIR = join(PACKAGE_ROOT, 'skills')
export const DEFAULT_LOCAL_SKILLS_DIR = join(PACKAGE_ROOT, 'skills-local')
export const SETUP_SKILL_NAME = 'penpot-setup'
export const WATCH_DEBOUNCE_MS = 150

/**
 * Rebase skill-local resource references onto the kit-root `resourceBase`.
 *
 * `resolve(ref)` may return the kit-root-relative target for a bare
 * `references/…` / `scripts/…` token (cross-skill references exist upstream:
 * penpot-build-deck uses penpot-anti-slop's `references/04-deck-tells.md`).
 * Without a resolver the reference is assumed to live in this skill.
 */
export function rewriteSkillRelativePaths(body, skillName, { resolve } = {}) {
  return body.replace(
    /(^|[^\w./-])((?:references|scripts)\/[A-Za-z0-9._~%+/-]*[A-Za-z0-9_~%+/-])/g,
    (match, lead, ref) => {
      const target = typeof resolve === 'function' ? resolve(ref) : `skills/${skillName}/${ref}`
      return target === undefined ? match : `${lead}${target}`
    },
  )
}

/** Resolve a bare skill-local reference to the skill that actually ships it. */
function makeResourceResolver(skillsRoot, skillName) {
  let dirs
  return (ref) => {
    if (existsSync(join(skillsRoot, skillName, ref))) return `skills/${skillName}/${ref}`
    dirs ??= readdirSync(skillsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    for (const dir of dirs) {
      if (dir !== skillName && existsSync(join(skillsRoot, dir, ref))) return `skills/${dir}/${ref}`
    }
    return undefined
  }
}

async function readCandidate(file, dir, { local, providerName, source, rank, logger }) {
  let parsed
  try {
    parsed = parseFrontmatter(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null) {
    logger?.warn?.(`dsh-penpot-ai-kit-plugin: skipping "${dir}" — SKILL.md has no frontmatter`)
    return undefined
  }
  const fields = toSkillFields(parsed.data, dir.split('/').pop())
  if (!SKILL_NAME.test(fields.name)) return undefined
  if (fields.description === '') return undefined
  return {
    name: fields.name,
    description: fields.description,
    ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
    invocation: fields.invocation,
    source,
    provider: providerName,
    rank,
    locator: { dir, path: file, local },
    path: file,
    ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
  }
}

async function discover(root, options) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    options.logger?.warn?.(`dsh-penpot-ai-kit-plugin: cannot read skills dir "${root}": ${error?.message ?? error}`)
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const candidate = await readCandidate(join(dir, 'SKILL.md'), dir, options)
    if (candidate !== undefined) found.push(candidate)
  }
  return found
}

/**
 * One provider instance. Created by `ctx.skills.registerProvider`.
 */
export class PenpotKitSkillProvider {
  #gate
  #config
  #ctx
  #control
  #watchers = []
  #debounceTimer

  constructor(ctx, control, config, gate) {
    this.#ctx = ctx
    this.#control = control
    this.#config = config
    this.#gate = gate
    control.signal.addEventListener('abort', () => { void this.dispose() }, { once: true })
    this.#startWatch()
  }

  get name() { return this.#config.providerName }

  async list() {
    const setup = await this.#setupCandidate()
    if (!this.#gate.isAvailable()) return setup === undefined ? [] : [setup]
    const vendored = await discover(this.#config.skillsDir, this.#options(false))
    const all = setup === undefined ? vendored : [...vendored, setup]
    return all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async get(candidate) {
    const locator = candidate?.locator
    if (locator === undefined) return undefined
    if (locator.local !== true && !this.#gate.isAvailable()) return undefined

    let parsed
    try {
      parsed = parseFrontmatter(await readFile(locator.path, 'utf8'))
    } catch {
      return undefined
    }
    if (parsed === null) return undefined
    const fields = toSkillFields(parsed.data, candidate.name)
    if (fields.name !== candidate.name) return undefined
    const local = locator.local === true
    return {
      name: fields.name,
      description: fields.description,
      ...(fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {}),
      invocation: fields.invocation,
      source: candidate.source,
      provider: this.#config.providerName,
      resourceBase: { kind: 'directory', path: local ? locator.dir : this.#config.resourceRoot },
      path: locator.path,
      ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
      content: local ? parsed.body : rewriteSkillRelativePaths(parsed.body, fields.name, {
        resolve: makeResourceResolver(this.#config.skillsDir, fields.name),
      }),
    }
  }

  async #setupCandidate() {
    const dir = join(this.#config.localSkillsDir, SETUP_SKILL_NAME)
    return readCandidate(join(dir, 'SKILL.md'), dir, { ...this.#options(false), local: true })
  }

  #options(local) {
    return {
      local,
      providerName: this.#config.providerName,
      source: this.#config.source,
      rank: this.#config.rank,
      logger: this.#ctx?.logger,
    }
  }

  #startWatch() {
    // Recursive `fs.watch` ignores `unref()` on Linux (the inotify tree pins
    // the event loop), which hangs short-lived runs and CI test workers.
    // Recursive is only used where it is safe; on Linux watch the parent
    // non-recursively — an upstream sync replaces the whole vendored dirs, so
    // a top-level event is still emitted.
    const recursive = process.platform === 'darwin' || process.platform === 'win32'
    const roots = recursive
      ? [...new Set([this.#config.skillsDir, this.#config.localSkillsDir])]
      : [...new Set([dirname(this.#config.skillsDir), dirname(this.#config.localSkillsDir)])]

    for (const root of roots) {
      let watcher
      try {
        watcher = recursive
          ? fsWatch(root, { recursive: true }, () => this.#invalidateDebounced())
          : fsWatch(root, () => this.#invalidateDebounced())
      } catch (error) {
        this.#ctx?.logger?.warn?.(`dsh-penpot-ai-kit-plugin: skills watcher unavailable (${error?.message ?? error}); synced skills appear after restart`)
        continue
      }
      if (this.#control.signal.aborted) {
        watcher.close()
        continue
      }
      watcher.unref?.()
      watcher.on('error', () => {
        try { watcher.close() } catch { /* already closed */ }
      })
      this.#watchers.push(watcher)
    }
  }

  #invalidateDebounced() {
    clearTimeout(this.#debounceTimer)
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined
      try {
        this.#control.invalidate()
      } catch { /* registration already disposed */ }
    }, WATCH_DEBOUNCE_MS)
  }

  /** Idempotent; called by the registration abort signal. */
  async dispose() {
    clearTimeout(this.#debounceTimer)
    const watchers = this.#watchers
    this.#watchers = []
    for (const watcher of watchers) {
      try { await watcher.close() } catch { /* already closed */ }
    }
  }
}

/** Paths used to build a provider; exported so tests can point at fixtures. */
export function providerPaths(config = {}) {
  const resourceRoot = config.resourceRoot === undefined ? PACKAGE_ROOT : resolve(config.resourceRoot)
  return {
    resourceRoot,
    skillsDir: config.skillsDir === undefined ? DEFAULT_SKILLS_DIR : resolve(config.skillsDir),
    localSkillsDir: config.localSkillsDir === undefined ? DEFAULT_LOCAL_SKILLS_DIR : resolve(config.localSkillsDir),
  }
}

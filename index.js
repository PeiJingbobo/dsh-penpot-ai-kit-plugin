/**
 * dsh-penpot-ai-kit — serve penpot/penpot-ai-kit as native DSH skills, behind a
 * verified Penpot MCP gate.
 *
 * A DeepSeek Harness bundle (`dsh.bundle`). It contributes:
 *
 * 1. A skill provider on `ctx.skills` for the vendored upstream library
 *    (14 skills) plus a local `penpot-setup` skill. When no Penpot MCP is
 *    usable, the provider exposes ONLY `penpot-setup`: the 14 design skills are
 *    not in the catalog at all.
 *
 * 2. A durable first-step reminder that forbids Penpot design work while the
 *    gate is closed, and routes the user to the config file.
 *
 * 3. `penpot_kit_status`, a native tool reporting
 *    `{configured, connected, serverName, toolCount, error, configPath}`.
 *
 * 4. The MCP connection itself: if the host already exposes
 *    `mcp__<serverName>__*` tools, the gate reuses them; otherwise it mounts
 *    `@deepseek-ai/dsh-mcp-client` as a child plugin. The import is dynamic and
 *    every failure is contained, so a missing config, a bad URL, or an
 *    unresolvable package can never fail host startup.
 *
 * Zero runtime dependencies, no build step, pure ESM.
 */

import { createMcpGate } from './lib/gate.mjs'
import { providerPaths, PenpotKitSkillProvider, SETUP_SKILL_NAME } from './lib/provider.mjs'
import { registerGateReminder } from './lib/reminder.mjs'
import { resolveConfigPath } from './lib/config.mjs'

export const name = 'dsh-penpot-ai-kit'
export const inject = ['skills', 'tools']

export const STATUS_TOOL_NAME = 'penpot_kit_status'

/** Per-context gate handle for tests and inspection (never returned from apply). */
const gates = new WeakMap()
export function gateFor(ctx) {
  return gates.get(ctx)
}
export const DEFAULT_PROVIDER_NAME = 'dsh-penpot-ai-kit'
export const DEFAULT_RANK = 650
export const DEFAULT_SOURCE = 'penpot-ai-kit'
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

const RESERVED_PROVIDER = 'runtime'

/** Row configuration, all optional. */
function resolvePluginConfig(config = {}) {
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME
  if (typeof providerName !== 'string' || providerName.length === 0) {
    throw new Error('dsh-penpot-ai-kit: providerName must be a non-empty string')
  }
  if (providerName === RESERVED_PROVIDER) {
    throw new Error(`dsh-penpot-ai-kit: providerName "${RESERVED_PROVIDER}" is reserved`)
  }
  const rank = config.rank ?? DEFAULT_RANK
  if (!Number.isFinite(rank)) throw new Error('dsh-penpot-ai-kit: rank must be a finite number')
  const source = config.source ?? DEFAULT_SOURCE
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('dsh-penpot-ai-kit: source must be a non-empty string')
  }
  const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
    throw new Error('dsh-penpot-ai-kit: connectTimeoutMs must be a non-negative number')
  }
  const paths = providerPaths(config)
  return {
    providerName,
    rank,
    source,
    connectTimeoutMs,
    configPath: config.configPath === undefined ? resolveConfigPath() : config.configPath,
    importMcp: config.importMcp,
    ...paths,
  }
}

/** The model-facing status tool; kept dependency-free (raw JSON Schema). */
export function registerStatusTool(ctx, gate) {
  const statusTool = {
    name: STATUS_TOOL_NAME,
    description:
      'Report whether the Penpot MCP connection for the dsh-penpot-ai-kit plugin is configured and usable. '
      + 'Returns the config file path, the expected server name, the live mcp__<serverName>__* tool count, '
      + 'and the last error. Call this before any Penpot work and whenever the user asks to set up Penpot.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          configured: { type: 'boolean' },
          connected: { type: 'boolean' },
          serverName: { type: 'string' },
          toolCount: { type: 'integer' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          configPath: { type: 'string' },
        },
        required: ['configured', 'connected', 'serverName', 'toolCount', 'error', 'configPath'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      // Self-heal the common setup flow: config created after the host started.
      if (!gate.isAvailable()) {
        gate.reload()
        if (gate.loaded?.configured === true && gate.toolCount() === 0 && gate.state === 'idle') {
          await gate.start()
        }
      }
      return gate.status()
    },
    presentCall() {
      return { card: 'generic', title: 'Penpot MCP status', kind: 'read' }
    },
  }
  return ctx.tools.register(statusTool)
}

/**
 * Register the provider, the status tool, the durable reminder, and the
 * availability listener. Never throws for a missing config.
 */
export async function apply(ctx, config = {}) {
  if (typeof ctx?.skills?.registerProvider !== 'function') {
    throw new Error('dsh-penpot-ai-kit requires the `skills` service (dsh-skill); add @deepseek-ai/dsh-base or equivalent to the profile')
  }
  if (typeof ctx?.tools?.register !== 'function') {
    throw new Error('dsh-penpot-ai-kit requires the `tools` service (dsh-tools)')
  }

  const resolved = resolvePluginConfig(config)
  const gate = createMcpGate(ctx, {
    configPath: resolved.configPath,
    connectTimeoutMs: resolved.connectTimeoutMs,
    importMcp: resolved.importMcp,
    logger: ctx.logger,
  })

  await gate.start()

  let invalidate = () => {}
  ctx.skills.registerProvider(control => {
    invalidate = () => {
      try { control.invalidate() } catch { /* registration already disposed */ }
    }
    gate.onChange = invalidate
    const provider = new PenpotKitSkillProvider(ctx, control, {
      providerName: resolved.providerName,
      source: resolved.source,
      rank: resolved.rank,
      resourceRoot: resolved.resourceRoot,
      skillsDir: resolved.skillsDir,
      localSkillsDir: resolved.localSkillsDir,
    }, gate)
    return provider
  })

  registerStatusTool(ctx, gate)
  registerGateReminder(ctx, gate)

  let lastCount = gate.toolCount()
  ctx.on('tools/change', () => {
    gate.refresh()
    const count = gate.toolCount()
    if (count !== lastCount) {
      lastCount = count
      invalidate()
    }
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { void gate.dispose() }, 'penpot-ai-kit.gate')
  }

  const status = gate.status()
  ctx.logger?.info?.(
    `dsh-penpot-ai-kit: gate ${status.connected ? 'open' : 'closed'} (${status.toolCount} mcp__${status.serverName}__* tools; config ${status.configPath})`,
  )
  if (!status.configured) {
    ctx.logger?.warn?.(`dsh-penpot-ai-kit: serving only "${SETUP_SKILL_NAME}" until a Penpot MCP config exists at ${status.configPath}`)
  }

  // Cordis collects a plugin apply()'s return value as an effect. Returning a
  // plain object makes activation fail with `TypeError: Invalid effect`, so
  // apply must resolve to undefined and expose the gate out of band.
  gates.set(ctx, gate)
}

export { parseFrontmatter, toSkillFields } from './lib/frontmatter.mjs'
export { loadConfig, validateConfig, resolveConfigPath, defaultConfigPath, CONFIG_ENV } from './lib/config.mjs'
export { createMcpGate } from './lib/gate.mjs'
export { PenpotKitSkillProvider, providerPaths, rewriteSkillRelativePaths, SETUP_SKILL_NAME } from './lib/provider.mjs'
export { renderGateReminder, GATE_SOURCE_KIND } from './lib/reminder.mjs'

/** Absolute path to the vendored kit root (contains skills/, shared/, …). */
export { PACKAGE_ROOT } from './lib/provider.mjs'

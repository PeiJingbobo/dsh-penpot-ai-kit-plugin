#!/usr/bin/env node
/**
 * The Penpot MCP gate.
 *
 * Availability is observed, not assumed: `connected` means the harness tool
 * registry currently exposes at least one `mcp__<serverName>__*` tool. The gate
 * either reuses an already-mounted MCP client or mounts
 * `@deepseek-ai/dsh-mcp-client` as a child plugin of this bundle. Every failure
 * path is contained — a missing file, a bad URL, or an unresolvable package
 * leaves the host running and the gate closed.
 */

import { loadConfig, resolveConfigPath, configuredServerName, toMcpClientConfig, DEFAULT_SERVER_NAME } from './config.mjs'

export const CONNECT_TIMEOUT_MS = 10_000

/** Error text safe to show a model: unwrap the mcp-client cause chain once. */
export function describeError(error) {
  if (error === undefined || error === null) return undefined
  const message = typeof error === 'string' ? error : error?.message ?? String(error)
  const cause = typeof error === 'object' ? error?.cause : undefined
  const causeMessage = typeof cause === 'string' ? cause : cause?.message
  if (causeMessage !== undefined && causeMessage !== '' && causeMessage !== message) {
    return `${message}: ${causeMessage}`
  }
  return message
}

/**
 * @param {object} ctx - cordis context with `tools` (and usually `logger`).
 * @param {object} [options]
 * @param {string} [options.configPath] - override (defaults to env/home resolution).
 * @param {number} [options.connectTimeoutMs] - startup wait cap.
 * @param {() => Promise<object>} [options.importMcp] - test seam for the dynamic import.
 */
export function createMcpGate(ctx, options = {}) {
  const configPath = options.configPath ?? resolveConfigPath()
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const importMcp = options.importMcp ?? (() => import('@deepseek-ai/dsh-mcp-client'))
  const logger = options.logger ?? ctx?.logger

  let loaded = loadConfig(configPath)
  let state = 'idle' // idle | mounting | mounted | reused | failed | timeout
  let mountError
  let fiber
  let disposed = false
  let lastToolCount = 0

  const serverName = () => configuredServerName(loaded)

  function toolCount() {
    let schemas = []
    try {
      schemas = ctx?.tools?.schemas?.() ?? []
    } catch {
      schemas = []
    }
    const prefix = `mcp__${serverName()}__`
    return Array.isArray(schemas) ? schemas.filter(schema => typeof schema?.name === 'string' && schema.name.startsWith(prefix)).length : 0
  }

  function isAvailable() {
    return loaded.configured === true && toolCount() > 0
  }

  function errorText() {
    if (!loaded.configured) return loaded.error ?? `Penpot MCP config not found at ${configPath}`
    if (toolCount() > 0) return null
    if (state === 'failed') return mountError ?? 'failed to mount the Penpot MCP client'
    if (state === 'timeout') return `timed out after ${connectTimeoutMs}ms waiting for the Penpot MCP handshake`
    if (state === 'mounting') return 'Penpot MCP connection is still in progress'
    return `Penpot MCP is configured but exposed no mcp__${serverName()}__* tools (check mcp.url / headers and that the server is running)`
  }

  function status() {
    lastToolCount = toolCount()
    return {
      configured: loaded.configured === true,
      connected: loaded.configured === true && lastToolCount > 0,
      serverName: serverName(),
      toolCount: lastToolCount,
      error: loaded.configured === true && lastToolCount > 0 ? null : errorText(),
      configPath: loaded.path,
    }
  }

  /** Re-read the config file (used when the setup skill rewrites it). */
  function reload() {
    loaded = loadConfig(configPath)
    if (!loaded.configured) {
      state = 'idle'
      mountError = undefined
    }
    return status()
  }

  /** Observe a registry change: a late connect or disconnect flips the gate. */
  function refresh() {
    const count = toolCount()
    if (count > 0 && state !== 'reused' && state !== 'mounted') {
      state = 'mounted'
      mountError = undefined
    }
    if (count !== lastToolCount) lastToolCount = count
    return status()
  }

  async function start() {
    loaded = loadConfig(configPath)
    for (const warning of loaded.warnings) logger?.warn?.(`dsh-penpot-ai-kit: ${warning}`)
    if (!loaded.configured) {
      logger?.warn?.(`dsh-penpot-ai-kit: ${loaded.error} — Penpot skills stay gated until it is fixed`)
      return status()
    }

    if (toolCount() > 0) {
      state = 'reused'
      logger?.info?.(`dsh-penpot-ai-kit: reusing existing mcp__${serverName()}__* tools`)
      return status()
    }

    let module
    try {
      module = await importMcp()
    } catch (error) {
      state = 'failed'
      mountError = `cannot load @deepseek-ai/dsh-mcp-client: ${describeError(error)}`
      logger?.warn?.(`dsh-penpot-ai-kit: ${mountError} — Penpot skills stay gated`)
      return status()
    }

    if (typeof ctx?.plugin !== 'function') {
      state = 'failed'
      mountError = 'the host context has no ctx.plugin(), so the Penpot MCP client cannot be mounted'
      logger?.warn?.(`dsh-penpot-ai-kit: ${mountError}`)
      return status()
    }

    state = 'mounting'
    try {
      fiber = ctx.plugin(module, toMcpClientConfig(loaded.config.mcp))
    } catch (error) {
      state = 'failed'
      mountError = describeError(error)
      logger?.warn?.(`dsh-penpot-ai-kit: cannot mount Penpot MCP client: ${mountError}`)
      return status()
    }

    const settled = Promise.resolve(fiber).then(
      () => {
        if (disposed) return
        if (toolCount() > 0) {
          state = 'mounted'
          mountError = undefined
          onChange()
        } else if (state === 'mounting') {
          state = 'mounted'
        }
        logger?.info?.(`dsh-penpot-ai-kit: Penpot MCP client active (${toolCount()} tools)`)
      },
      (error) => {
        if (disposed) return
        state = 'failed'
        mountError = describeError(error)
        logger?.warn?.(`dsh-penpot-ai-kit: Penpot MCP client failed to start: ${mountError}`)
        onChange()
      },
    )

    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), connectTimeoutMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([settled.then(() => 'settled'), timeout])
    clearTimeout(timer)
    if (outcome === 'timeout' && state === 'mounting') {
      state = 'timeout'
      logger?.warn?.(`dsh-penpot-ai-kit: Penpot MCP handshake has not settled after ${connectTimeoutMs}ms; continuing in the background`)
    }
    return status()
  }

  /** Set by the skill provider registration; fired when availability flips late. */
  let onChange = () => {}

  async function dispose() {
    disposed = true
    if (fiber !== undefined && typeof fiber.dispose === 'function') {
      try { await fiber.dispose() } catch { /* best effort */ }
    }
  }

  return {
    start,
    status,
    reload,
    refresh,
    dispose,
    toolCount,
    isAvailable,
    get state() { return state },
    get error() { return errorText() },
    get serverName() { return serverName() },
    get configPath() { return loaded.path },
    set onChange(fn) { onChange = typeof fn === 'function' ? fn : () => {} },
    get loaded() { return loaded },
    get mountError() { return mountError },
    DEFAULT_SERVER_NAME,
  }
}

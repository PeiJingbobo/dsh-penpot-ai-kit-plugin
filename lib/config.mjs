#!/usr/bin/env node
/**
 * Config discovery + validation for the Penpot MCP gate.
 *
 * The gate is deliberately strict at the boundary: a typo must surface as a
 * readable error on `penpot_kit_status`, never silently fall back to a
 * different endpoint or timeout. Nothing here throws — the caller (and
 * therefore host startup) must survive every malformed file.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const CONFIG_ENV = 'PENPOT_AI_KIT_CONFIG'
export const DEFAULT_SERVER_NAME = 'penpot'
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000
export const CONFIG_VERSION = 1

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const HTTP_KEYS = new Set(['serverName', 'transport', 'url', 'headers', 'toolCallTimeoutMs'])
const STDIO_KEYS = new Set(['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs'])

/** Default config path: `~/.dsh/penpot-ai-kit/config.json`. */
export function defaultConfigPath(home = homedir()) {
  return join(home, '.dsh', 'penpot-ai-kit', 'config.json')
}

/** Resolve the config path, honoring `PENPOT_AI_KIT_CONFIG`. */
export function resolveConfigPath(env = process.env, home = homedir()) {
  const override = env?.[CONFIG_ENV]
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  return defaultConfigPath(home)
}

/**
 * Read and validate the config file.
 * @returns {{ configured: boolean, path: string, config?: object, error?: string, warnings: string[] }}
 */
export function loadConfig(path = resolveConfigPath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return {
      configured: false,
      path,
      error: missing
        ? `Penpot MCP config not found at ${path}`
        : `cannot read Penpot MCP config at ${path}: ${error?.message ?? error}`,
      warnings: [],
    }
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      configured: false,
      path,
      error: `invalid JSON in ${path}: ${error?.message ?? error}`,
      warnings: [],
    }
  }

  const validated = validateConfig(raw)
  if (!validated.ok) {
    return { configured: false, path, error: `${path}: ${validated.error}`, warnings: [] }
  }

  return {
    configured: true,
    path,
    config: validated.config,
    warnings: permissionWarnings(path),
  }
}

/** Validate an already-parsed config object and normalize defaults. */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'config root must be a JSON object' }
  if (raw.version !== CONFIG_VERSION) {
    return { ok: false, error: `config.version must be ${CONFIG_VERSION}` }
  }
  if (!isPlainObject(raw.mcp)) return { ok: false, error: 'config.mcp must be an object' }

  const mcp = raw.mcp
  const transport = mcp.transport ?? (mcp.url !== undefined ? 'streamable-http' : mcp.command !== undefined ? 'stdio' : undefined)
  if (transport !== 'streamable-http' && transport !== 'stdio') {
    return { ok: false, error: 'mcp.transport must be "streamable-http" or "stdio"' }
  }

  const allowed = transport === 'streamable-http' ? HTTP_KEYS : STDIO_KEYS
  for (const key of Object.keys(mcp)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `mcp.${key} is not a supported ${transport} field` }
    }
  }

  const serverName = mcp.serverName ?? DEFAULT_SERVER_NAME
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    return { ok: false, error: 'mcp.serverName must match [A-Za-z0-9_-]{1,32}' }
  }

  const timeout = mcp.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    return { ok: false, error: 'mcp.toolCallTimeoutMs must be a positive integer (milliseconds)' }
  }

  if (transport === 'streamable-http') {
    if (typeof mcp.url !== 'string' || mcp.url.trim() === '') {
      return { ok: false, error: 'mcp.url is required for the streamable-http transport' }
    }
    let parsed
    try {
      parsed = new URL(mcp.url)
    } catch {
      return { ok: false, error: `mcp.url is not a valid URL: ${mcp.url}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'mcp.url must use http:// or https://' }
    }
    const headers = mcp.headers ?? {}
    if (!isPlainObject(headers)) return { ok: false, error: 'mcp.headers must be an object of string values' }
    for (const [key, value] of Object.entries(headers)) {
      if (key === '' || typeof value !== 'string') {
        return { ok: false, error: `mcp.headers.${key || '(empty)'} must be a string` }
      }
    }
    return {
      ok: true,
      config: {
        version: CONFIG_VERSION,
        mcp: { serverName, transport, url: mcp.url.trim(), headers: { ...headers }, toolCallTimeoutMs: timeout },
      },
    }
  }

  if (typeof mcp.command !== 'string' || mcp.command.trim() === '') {
    return { ok: false, error: 'mcp.command is required for the stdio transport' }
  }
  const args = mcp.args ?? []
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return { ok: false, error: 'mcp.args must be an array of strings' }
  }
  const env = mcp.env ?? {}
  if (!isPlainObject(env) || Object.values(env).some(value => typeof value !== 'string')) {
    return { ok: false, error: 'mcp.env must be an object of string values' }
  }
  const cwd = mcp.cwd ?? ''
  if (typeof cwd !== 'string') return { ok: false, error: 'mcp.cwd must be a string' }

  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      mcp: { serverName, transport, command: mcp.command, args: [...args], env: { ...env }, cwd, toolCallTimeoutMs: timeout },
    },
  }
}

/**
 * Build the exact config object `@deepseek-ai/dsh-mcp-client` expects.
 * `failOnStartupError` is forced true so a bad URL rejects this child fiber and
 * the gate can report the real cause instead of a silent "no tools" state.
 */
export function toMcpClientConfig(mcp) {
  const base = { serverName: mcp.serverName, transport: mcp.transport, toolCallTimeoutMs: mcp.toolCallTimeoutMs, failOnStartupError: true }
  if (mcp.transport === 'streamable-http') {
    return { ...base, url: mcp.url, headers: mcp.headers }
  }
  return { ...base, command: mcp.command, args: mcp.args, env: mcp.env, cwd: mcp.cwd }
}

/** Human-readable `serverName` from a load result, even when unconfigured. */
export function configuredServerName(loaded) {
  return loaded?.config?.mcp?.serverName ?? DEFAULT_SERVER_NAME
}

function permissionWarnings(path) {
  try {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) {
      return [`${path} is group/world accessible (mode ${mode.toString(8)}); run: chmod 600 ${path}`]
    }
  } catch {
    // Permission introspection is advisory only.
  }
  return []
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

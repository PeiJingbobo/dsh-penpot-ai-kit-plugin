import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  CONFIG_ENV,
  DEFAULT_SERVER_NAME,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  defaultConfigPath,
  loadConfig,
  resolveConfigPath,
  validateConfig,
} from '../lib/config.mjs'
import { VALID_CONFIG, makeTempDir } from './helpers.mjs'

test('accepts the documented config and normalizes defaults', () => {
  const result = validateConfig(VALID_CONFIG)
  assert.equal(result.ok, true)
  assert.deepEqual(result.config, VALID_CONFIG)

  const minimal = validateConfig({ version: 1, mcp: { url: 'http://localhost:4401/mcp' } })
  assert.equal(minimal.ok, true)
  assert.equal(minimal.config.mcp.serverName, DEFAULT_SERVER_NAME)
  assert.equal(minimal.config.mcp.transport, 'streamable-http')
  assert.equal(minimal.config.mcp.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS)
  assert.deepEqual(minimal.config.mcp.headers, {})
})

test('rejects malformed configs with readable errors', () => {
  const cases = [
    [{}, /version|mcp/],
    [{ version: 2, mcp: {} }, /version/],
    [{ version: 1 }, /mcp/],
    [{ version: 1, mcp: { transport: 'websocket', url: 'http://x' } }, /transport/],
    [{ version: 1, mcp: { transport: 'streamable-http' } }, /url/],
    [{ version: 1, mcp: { transport: 'streamable-http', url: 'not a url' } }, /valid URL/],
    [{ version: 1, mcp: { transport: 'streamable-http', url: 'ftp://x/mcp' } }, /http/],
    [{ version: 1, mcp: { transport: 'streamable-http', url: 'http://x', headers: { A: 1 } } }, /headers/],
    [{ version: 1, mcp: { transport: 'streamable-http', url: 'http://x', toolCallTimeoutMs: 0 } }, /toolCallTimeoutMs/],
    [{ version: 1, mcp: { transport: 'streamable-http', url: 'http://x', serverName: 'bad name!' } }, /serverName/],
    [{ version: 1, mcp: { transport: 'streamable-http', url: 'http://x', command: 'npx' } }, /not a supported/],
    [{ version: 1, mcp: { transport: 'stdio' } }, /command/],
    [{ version: 1, mcp: { transport: 'stdio', command: 'npx', args: 'x' } }, /args/],
  ]
  for (const [raw, pattern] of cases) {
    const result = validateConfig(raw)
    assert.equal(result.ok, false, JSON.stringify(raw))
    assert.match(result.error, pattern)
  }
})

test('supports stdio transport', () => {
  const result = validateConfig({ version: 1, mcp: { transport: 'stdio', serverName: 'penpot', command: 'npx', args: ['-y', 'mcp-remote'] } })
  assert.equal(result.ok, true)
  assert.equal(result.config.mcp.command, 'npx')
  assert.deepEqual(result.config.mcp.args, ['-y', 'mcp-remote'])
  assert.deepEqual(result.config.mcp.env, {})
})

test('missing config is reported, never thrown', () => {
  const loaded = loadConfig('/definitely/not/here/config.json')
  assert.equal(loaded.configured, false)
  assert.match(loaded.error, /not found/)
  assert.deepEqual(loaded.warnings, [])
})

test('invalid JSON is reported, never thrown', () => {
  const temp = makeTempDir()
  try {
    const path = temp.write('{ nope')
    const loaded = loadConfig(path)
    assert.equal(loaded.configured, false)
    assert.match(loaded.error, /invalid JSON/)
  } finally {
    temp.cleanup()
  }
})

test('valid config loads and warns when permissions are too open', { skip: process.platform === 'win32' }, () => {
  const temp = makeTempDir()
  try {
    const path = temp.write(VALID_CONFIG, { mode: 0o644 })
    const loaded = loadConfig(path)
    assert.equal(loaded.configured, true)
    assert.equal(loaded.config.mcp.url, VALID_CONFIG.mcp.url)
    assert.equal(loaded.warnings.length, 1)
    assert.match(loaded.warnings[0], /chmod 600/)

    temp.write(VALID_CONFIG, { mode: 0o600 })
    assert.deepEqual(loadConfig(path).warnings, [])
  } finally {
    temp.cleanup()
  }
})

test('config path honors PENPOT_AI_KIT_CONFIG', () => {
  assert.equal(CONFIG_ENV, 'PENPOT_AI_KIT_CONFIG')
  assert.equal(resolveConfigPath({ [CONFIG_ENV]: '/tmp/custom.json' }, '/home/u'), '/tmp/custom.json')
  assert.equal(resolveConfigPath({}, '/home/u'), join('/home/u', '.dsh', 'penpot-ai-kit', 'config.json'))
  assert.equal(defaultConfigPath('/home/u'), join('/home/u', '.dsh', 'penpot-ai-kit', 'config.json'))
  assert.equal(resolveConfigPath({ [CONFIG_ENV]: '   ' }, '/home/u'), join('/home/u', '.dsh', 'penpot-ai-kit', 'config.json'))
})

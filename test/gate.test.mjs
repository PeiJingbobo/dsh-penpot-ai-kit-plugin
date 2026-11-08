import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpGate } from '../lib/gate.mjs'
import { VALID_CONFIG, createFakeContext, makeTempDir, mcpTool } from './helpers.mjs'

function withTempConfig(t, config = VALID_CONFIG) {
  const temp = makeTempDir()
  t.after(() => temp.cleanup())
  if (config !== undefined) temp.write(config)
  return temp
}

test('closed gate: missing config never mounts and never throws', async () => {
  const temp = makeTempDir()
  const harness = createFakeContext()
  try {
    const gate = createMcpGate(harness.ctx, { configPath: temp.configPath })
    const status = await gate.start()
    assert.equal(status.configured, false)
    assert.equal(status.connected, false)
    assert.equal(status.serverName, 'penpot')
    assert.equal(status.toolCount, 0)
    assert.match(status.error, /not found/)
    assert.equal(status.configPath, temp.configPath)
    assert.equal(harness.state.pluginCalls, 0)
  } finally {
    temp.cleanup()
  }
})

test('reuses already-registered mcp__<server>__* tools instead of mounting', async (t) => {
  const temp = withTempConfig(t)
  const harness = createFakeContext({ toolSchemas: [mcpTool('execute_code'), mcpTool('export_shape')] })
  const gate = createMcpGate(harness.ctx, { configPath: temp.configPath })
  const status = await gate.start()
  assert.equal(status.configured, true)
  assert.equal(status.connected, true)
  assert.equal(status.toolCount, 2)
  assert.equal(status.error, null)
  assert.equal(gate.state, 'reused')
  assert.equal(harness.state.pluginCalls, 0)
})

test('mounts the MCP client as a child plugin and flips connected when tools land', async (t) => {
  const temp = withTempConfig(t)
  let harness
  harness = createFakeContext({ plugin: async () => { harness.setTools([mcpTool('execute_code')]) } })
  const gate = createMcpGate(harness.ctx, { configPath: temp.configPath, importMcp: async () => ({ name: 'fake' }) })
  const status = await gate.start()
  assert.equal(status.configured, true)
  assert.equal(status.connected, true)
  assert.equal(status.toolCount, 1)
  assert.equal(harness.state.pluginCalls, 1)
})

test('a failing mount is reported, not thrown', async (t) => {
  const temp = withTempConfig(t)
  const harness = createFakeContext({
    plugin: async () => { throw new Error('mcp-client(penpot): initial connection or tool synchronization failed') },
  })
  const gate = createMcpGate(harness.ctx, { configPath: temp.configPath, importMcp: async () => ({ name: 'fake' }) })
  const status = await gate.start()
  assert.equal(status.configured, true)
  assert.equal(status.connected, false)
  assert.equal(status.toolCount, 0)
  assert.match(status.error, /initial connection/)
  assert.equal(gate.state, 'failed')
})

test('an unresolvable mcp-client package is reported, not thrown', async (t) => {
  const temp = withTempConfig(t)
  const harness = createFakeContext()
  const gate = createMcpGate(harness.ctx, {
    configPath: temp.configPath,
    importMcp: async () => { throw new Error("Cannot find package '@deepseek-ai/dsh-mcp-client'") },
  })
  const status = await gate.start()
  assert.equal(status.configured, true)
  assert.equal(status.connected, false)
  assert.match(status.error, /cannot load @deepseek-ai\/dsh-mcp-client/)
})

test('a hanging handshake times out without blocking forever', async (t) => {
  const temp = withTempConfig(t)
  const harness = createFakeContext({ plugin: () => new Promise(resolve => setTimeout(resolve, 50)) })
  const gate = createMcpGate(harness.ctx, { configPath: temp.configPath, connectTimeoutMs: 10, importMcp: async () => ({ name: 'fake' }) })
  const status = await gate.start()
  assert.equal(status.connected, false)
  assert.match(status.error, /timed out after 10ms/)
  assert.equal(gate.state, 'timeout')
})

test('refresh picks up tools that appear after startup', async (t) => {
  const temp = withTempConfig(t)
  const harness = createFakeContext({ plugin: async () => {} })
  const gate = createMcpGate(harness.ctx, { configPath: temp.configPath })
  await gate.start()
  assert.equal(gate.status().connected, false)
  harness.setTools([mcpTool('export_shape')])
  const status = gate.refresh()
  assert.equal(status.connected, true)
  assert.equal(status.toolCount, 1)
  assert.equal(status.error, null)
})

test('invalid config is surfaced through status', async (t) => {
  const temp = withTempConfig(t, { version: 1, mcp: { transport: 'streamable-http', url: 'nope' } })
  const harness = createFakeContext()
  const gate = createMcpGate(harness.ctx, { configPath: temp.configPath })
  const status = await gate.start()
  assert.equal(status.configured, false)
  assert.match(status.error, /valid URL/)
})

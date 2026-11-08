import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, STATUS_TOOL_NAME, GATE_SOURCE_KIND, gateFor } from '../index.js'
import { VALID_CONFIG, callTool, createFakeContext, makeTempDir, mcpTool } from './helpers.mjs'

function withTempConfig(t, config) {
  const temp = makeTempDir()
  t.after(() => temp.cleanup())
  if (config !== undefined) temp.write(config)
  return temp
}

test('missing config: gate closed, only penpot-setup, status explains the path', async (t) => {
  const temp = withTempConfig(t)
  const harness = createFakeContext()
  const result = await apply(harness.ctx, { configPath: temp.configPath })
  assert.equal(result, undefined, 'apply must not return an effect-shaped value')
  assert.ok(gateFor(harness.ctx))

  const list = await harness.state.provider.list()
  assert.deepEqual(list.map(skill => skill.name), ['penpot-setup'])

  const status = await callTool(harness, STATUS_TOOL_NAME)
  assert.deepEqual(Object.keys(status).sort(), ['configPath', 'configured', 'connected', 'error', 'serverName', 'toolCount'])
  assert.equal(status.configured, false)
  assert.equal(status.connected, false)
  assert.equal(status.serverName, 'penpot')
  assert.equal(status.toolCount, 0)
  assert.equal(status.configPath, temp.configPath)
  assert.match(status.error, /not found/)

  const decision = await harness.preStep()
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  const text = decision.messages[0].content[0].text
  assert.match(text, /不得执行任何 Penpot 设计操作/)
  assert.match(text, /penpot_kit_status/)
  assert.match(text, /penpot-setup/)

  // The same durable message is present next step: no duplicate injection.
  const again = await harness.preStep({
    agent: {
      session: {
        events: [{ type: 'user/message', data: { source: { kind: GATE_SOURCE_KIND } }, seq: 3 }],
        surface: { nodes: [3] },
      },
    },
  })
  assert.equal(again.messages.length, 0)
})

test('configured + existing tools: gate open, all 15 skills, no reminder', async (t) => {
  const temp = withTempConfig(t, VALID_CONFIG)
  const harness = createFakeContext({ toolSchemas: [mcpTool('execute_code'), mcpTool('export_shape')] })
  await apply(harness.ctx, { configPath: temp.configPath })
  assert.equal(gateFor(harness.ctx).state, 'reused')

  const list = await harness.state.provider.list()
  assert.equal(list.length, 15)
  assert.ok(list.some(skill => skill.name === 'penpot-audit-tokens'))

  const status = await callTool(harness, STATUS_TOOL_NAME)
  assert.equal(status.configured, true)
  assert.equal(status.connected, true)
  assert.equal(status.toolCount, 2)
  assert.equal(status.error, null)

  const decision = await harness.preStep()
  assert.equal(decision.messages.length, 0)
})

test('bad URL: status reports the failure and the catalog stays gated', async (t) => {
  const temp = withTempConfig(t, VALID_CONFIG)
  const harness = createFakeContext({
    plugin: async () => { throw new Error('mcp-client(penpot): initial connection failed: fetch failed') },
  })
  await apply(harness.ctx, { configPath: temp.configPath, importMcp: async () => ({ name: 'fake' }) })
  assert.equal(gateFor(harness.ctx).state, 'failed')

  const status = await callTool(harness, STATUS_TOOL_NAME)
  assert.equal(status.configured, true)
  assert.equal(status.connected, false)
  assert.match(status.error, /fetch failed/)

  const list = await harness.state.provider.list()
  assert.deepEqual(list.map(skill => skill.name), ['penpot-setup'])
})

test('status self-heals when the config appears after startup', async (t) => {
  const temp = withTempConfig(t, undefined)
  const harness = createFakeContext()
  harness.ctx.plugin = async () => { harness.setTools([mcpTool('execute_code')]) }
  await apply(harness.ctx, { configPath: temp.configPath, importMcp: async () => ({ name: 'fake' }) })

  let status = await callTool(harness, STATUS_TOOL_NAME)
  assert.equal(status.configured, false)

  temp.write(VALID_CONFIG, { mode: 0o600 })
  status = await callTool(harness, STATUS_TOOL_NAME)
  assert.equal(status.configured, true)
  assert.equal(status.connected, true)
  assert.equal(status.toolCount, 1)
})

test('tools/change re-evaluates the gate and invalidates the catalog', async (t) => {
  const temp = withTempConfig(t, VALID_CONFIG)
  const harness = createFakeContext()
  harness.ctx.plugin = async () => {}
  await apply(harness.ctx, { configPath: temp.configPath })

  assert.equal((await harness.state.provider.list()).length, 1)
  const before = harness.state.invalidations

  harness.setTools([mcpTool('execute_code')])
  await harness.emit('tools/change')

  assert.ok(harness.state.invalidations > before)
  assert.equal((await harness.state.provider.list()).length, 15)
})

test('apply fails loudly only when the required host services are absent', async () => {
  await assert.rejects(() => apply({ tools: { register() {} } }), /skills/)
  await assert.rejects(() => apply({ skills: { registerProvider() {} } }), /tools/)
})

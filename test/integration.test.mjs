// Real-DSH integration test. It only runs where the host profile packages are
// resolvable (the Docker verification image); `node --test` on a plain checkout
// skips it instead of failing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VALID_CONFIG, makeTempDir } from './helpers.mjs'

async function loadDsh() {
  try {
    const [{ Context }, { SystemPrompt }, { ToolRuntime }, { SkillRegistry }, mcpClient] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-skill'),
      import('@deepseek-ai/dsh-mcp-client'),
    ])
    return { Context, SystemPrompt, ToolRuntime, SkillRegistry, mcpClient }
  } catch {
    return null
  }
}

const dsh = await loadDsh()
const skip = dsh === null ? 'DSH packages are not installed in this environment' : false

test('nested MCP mount: status, catalog, resourceBase and a read-only call', { skip }, async (t) => {
  const { startFakePenpot } = await import('./fixtures/fake-penpot.mjs')
  const { apply, STATUS_TOOL_NAME, PACKAGE_ROOT } = await import(process.env.PENPOT_AI_KIT_ENTRY ?? '../index.js')
  const server = await startFakePenpot(0)
  const temp = makeTempDir()
  temp.write({ ...VALID_CONFIG, mcp: { ...VALID_CONFIG.mcp, url: server.url } }, { mode: 0o600 })

  const ctx = new dsh.Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() } catch { /* already disposed */ }
    await server.close()
    temp.cleanup()
  })
  await ctx.plugin(dsh.SystemPrompt)
  await ctx.plugin(dsh.ToolRuntime)
  await ctx.plugin(dsh.SkillRegistry)

  const result = await apply(ctx, { configPath: temp.configPath, connectTimeoutMs: 5000 })
  assert.equal(result.gate.state, 'mounted')

  const status = await ctx.tools.get(STATUS_TOOL_NAME).execute({}, { signal: new AbortController().signal })
  assert.equal(status.configured, true)
  assert.equal(status.connected, true)
  assert.ok(status.toolCount >= 3, `toolCount=${status.toolCount}`)

  const skills = await ctx.skills.list()
  assert.equal(skills.length, 15)
  assert.ok(skills.some(skill => skill.name === 'penpot-router'))

  const audit = await ctx.skills.get('penpot-audit-tokens')
  assert.equal(audit.resourceBase.kind, 'directory')
  assert.equal(audit.resourceBase.path, PACKAGE_ROOT)
  assert.ok(existsSync(join(PACKAGE_ROOT, 'shared', 'penpot-mcp-tool-reference.md')))
  assert.match(audit.content, /skills\/penpot-audit-tokens\/references\//)

  const call = await ctx.tools.execute({
    callId: 'integration-read-only',
    name: 'mcp__penpot__execute_code',
    arguments: { code: 'return penpotUtils.shapeStructure()' },
    signal: new AbortController().signal,
  })
  assert.equal(call.isError, false)
  assert.match(String(call.content?.[0]?.text ?? ''), /executed:/)
})

test('bad URL against the real mcp-client: status errors, catalog gated', { skip }, async () => {
  const { apply, STATUS_TOOL_NAME } = await import(process.env.PENPOT_AI_KIT_ENTRY ?? '../index.js')
  const temp = makeTempDir()
  temp.write({ ...VALID_CONFIG, mcp: { ...VALID_CONFIG.mcp, url: 'http://127.0.0.1:1/mcp' } }, { mode: 0o600 })
  const ctx = new dsh.Context()
  try {
    await ctx.plugin(dsh.SystemPrompt)
    await ctx.plugin(dsh.ToolRuntime)
    await ctx.plugin(dsh.SkillRegistry)
    await apply(ctx, { configPath: temp.configPath, connectTimeoutMs: 5000 })

    const status = await ctx.tools.get(STATUS_TOOL_NAME).execute({}, { signal: new AbortController().signal })
    assert.equal(status.configured, true)
    assert.equal(status.connected, false)
    assert.ok(typeof status.error === 'string' && status.error.length > 0)

    const skills = await ctx.skills.list()
    assert.deepEqual(skills.map(skill => skill.name), ['penpot-setup'])
  } finally {
    try { await ctx.fiber.dispose() } catch { /* already disposed */ }
    temp.cleanup()
  }
})

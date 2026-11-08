import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Temp dir helper; call `t.after(() => cleanup())` in the test. */
export function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-penpot-kit-'))
  return {
    dir,
    configPath: join(dir, 'config.json'),
    write(config, { mode } = {}) {
      const path = this.configPath
      writeFileSync(path, typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`)
      if (mode !== undefined) chmodSync(path, mode)
      return path
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const VALID_CONFIG = {
  version: 1,
  mcp: {
    serverName: 'penpot',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:4401/mcp',
    headers: {},
    toolCallTimeoutMs: 120000,
  },
}

export function mcpTool(name = 'execute_code', serverName = 'penpot') {
  return { name: `mcp__${serverName}__${name}`, description: 'fake', parameters: { type: 'object', properties: {} } }
}

/**
 * Minimal fake cordis context exposing exactly the surfaces this bundle uses:
 * skills.registerProvider, tools.register/schemas/get, on(), effect(), plugin().
 */
export function createFakeContext({ toolSchemas = [], plugin } = {}) {
  const state = {
    toolSchemas: [...toolSchemas],
    provider: undefined,
    providerControl: undefined,
    tools: new Map(),
    listeners: new Map(),
    effects: [],
    invalidations: 0,
    pluginCalls: 0,
    disposed: false,
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    skills: {
      registerProvider(factory) {
        const control = {
          signal: new AbortController().signal,
          invalidate() { state.invalidations += 1 },
        }
        state.providerControl = control
        state.provider = factory(control)
        return () => { state.disposed = true }
      },
    },
    tools: {
      schemas: () => state.toolSchemas,
      register(definition) { state.tools.set(definition.name, definition); return () => state.tools.delete(definition.name) },
      get: name => state.tools.get(name),
    },
    on(event, listener) {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {}
    },
    effect(factory) { state.effects.push(factory); return factory },
    async plugin(module, config) {
      state.pluginCalls += 1
      if (typeof plugin === 'function') return plugin(module, config)
      return Promise.resolve()
    },
  }

  return {
    ctx,
    state,
    setTools(schemas) { state.toolSchemas = schemas },
    async emit(event, payload) {
      for (const listener of state.listeners.get(event) ?? []) {
        await listener(payload, async () => ({ kind: 'enter', messages: [] }))
      }
    },
    async preStep(payload = {}) {
      let decision = { kind: 'enter', messages: [] }
      for (const listener of state.listeners.get('agent/pre-step') ?? []) {
        decision = await listener(payload, async () => decision)
      }
      return decision
    },
  }
}

/** Call a registered fake tool and return its canonical value. */
export async function callTool(harness, name) {
  const definition = harness.state.tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return definition.execute({}, { signal: new AbortController().signal })
}

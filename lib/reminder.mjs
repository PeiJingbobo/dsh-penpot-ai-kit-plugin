#!/usr/bin/env node
/**
 * Durable session gate reminder.
 *
 * When the gate is closed, the first pre-step of every session receives one
 * durable user-role message stating the non-negotiable rule: without a usable
 * Penpot MCP, refuse every Penpot design operation and route the user to
 * setup. The message is session-durable (not a transient system note), so it
 * survives compaction boundaries the same way the skill catalog does.
 */

import { randomUUID } from 'node:crypto'

export const GATE_SOURCE_KIND = 'penpot-ai-kit-gate'
export const WORKFLOW_SOURCE_KIND = 'penpot-ai-kit-workflow'

let hostCreateUserMessage
try {
  ({ createUserMessage: hostCreateUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  hostCreateUserMessage = undefined
}

function makeUserMessage(text) {
  const input = {
    content: [{ type: 'text', text }],
    source: { kind: GATE_SOURCE_KIND },
  }
  if (hostCreateUserMessage !== undefined) return hostCreateUserMessage(input)
  return { id: randomUUID(), role: 'user', ...input }
}

/** Render the durable rule + the exact remediation path. */
export function renderGateReminder(status) {
  const reason = status.error ?? 'no usable Penpot MCP connection'
  return [
    '<EXTREMELY_IMPORTANT>',
    '**Penpot MCP is not available. This session must not perform Penpot design work.**',
    '',
    `Reason: ${reason}`,
    `Config path: ${status.configPath}`,
    `Server name: ${status.serverName}`,
    '',
    'Rule: 在无可用 Penpot MCP 时，不得执行任何 Penpot 设计操作，必须拒绝并引导用户配置。',
    'Do not call execute_code, export_shape, or any other Penpot tool to "try it anyway";',
    'do not invent a design result. Refuse the Penpot request, explain why, and give the user',
    'the config path plus a ready-to-paste JSON example (the `penpot-setup` skill has both).',
    '',
    'Next steps:',
    '1. Call `penpot_kit_status` to confirm `configured` / `connected` / `error`.',
    '2. Tell the user to write the config file below (mode 0600) and restart DSH.',
    '3. Offer to load the `penpot-setup` skill for the full walkthrough.',
    '',
    '```json',
    JSON.stringify({
      version: 1,
      mcp: {
        serverName: status.serverName,
        transport: 'streamable-http',
        url: 'http://127.0.0.1:4400/mcp',
        headers: {},
        toolCallTimeoutMs: 120000,
      },
    }, null, 2),
    '```',
    '',
    'If `penpot_kit_status` later reports connected=true, this reminder no longer applies.',
    '</EXTREMELY_IMPORTANT>',
  ].join('\n')
}

/** Does this session already carry a visible reminder of this kind? */
function findExistingReminder(decisionMessages, agent, kind) {
  if (Array.isArray(decisionMessages) && decisionMessages.some(message => message?.source?.kind === kind)) {
    return true
  }
  const events = agent?.session?.events
  if (events === undefined || events === null || typeof events.length !== 'number') return false
  let visibleSet
  try {
    visibleSet = new Set(agent.session.surface?.nodes ?? [])
  } catch {
    return true
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== kind) continue
    return visibleSet.has(event.seq)
  }
  return false
}

/** Register the once-per-session reminder, active only while the gate is closed. */
export function registerGateReminder(ctx, gate) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (gate.isAvailable()) return decision
    signal?.throwIfAborted?.()
    if (findExistingReminder(decision.messages, agent, GATE_SOURCE_KIND)) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, makeUserMessage(renderGateReminder(gate.status()))],
    }
  })
}


/** Render the "MCP is available, now use the workflow" rule. */
export function renderWorkflowReminder(status) {
  return [
    '<EXTREMELY_IMPORTANT>',
    '**Penpot MCP is available. Use the Penpot workflow skills before touching the canvas.**',
    '',
    `Config: ${status.configPath} · server: ${status.serverName} · tools: ${status.toolCount}`,
    '',
    'Rules for this session:',
    '1. Before ANY Penpot design task, load `penpot-router` first, then the skill it routes to',
    '   (`penpot-build-screen`, `penpot-build-from-code`, `penpot-component-factory`, `penpot-audit-*`, ...).',
    '2. Do NOT generate or restyle a screen by calling `execute_code` directly. Never one-shot a screen.',
    '   Build section by section; after each section call `export_shape` and actually look at the image.',
    '3. Before declaring the work done, load `penpot-polish` and run its `auditDesignTells.js`;',
    '   fix every P0 finding (broken geometry, layout-less boards, orphan shapes) before reporting.',
    '4. If the `penpot-*` skills are not in your catalog yet, call `penpot_kit_status` and ask the',
    '   user to restart DSH before building. Do not improvise a design in the meantime.',
    '',
    'Read-only inspection still starts with `penpot-router`. This reminder is once per session.',
    '</EXTREMELY_IMPORTANT>',
  ].join('\n')
}

/** Inject the workflow rule once per session, only while the gate is open. */
export function registerWorkflowReminder(ctx, gate) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!gate.isAvailable()) return decision
    signal?.throwIfAborted?.()
    if (findExistingReminder(decision.messages, agent, WORKFLOW_SOURCE_KIND)) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, makeUserMessage(renderWorkflowReminder(gate.status()))],
    }
  })
}

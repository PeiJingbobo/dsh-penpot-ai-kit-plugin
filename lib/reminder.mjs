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

/** Does this session already carry a visible gate reminder? */
function findExistingReminder(decisionMessages, agent) {
  if (Array.isArray(decisionMessages) && decisionMessages.some(message => message?.source?.kind === GATE_SOURCE_KIND)) {
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
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== GATE_SOURCE_KIND) continue
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
    if (findExistingReminder(decision.messages, agent)) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, makeUserMessage(renderGateReminder(gate.status()))],
    }
  })
}

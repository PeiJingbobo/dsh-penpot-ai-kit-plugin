#!/usr/bin/env node
/**
 * Dependency-free frontmatter parser for the Penpot kit's SKILL.md files.
 *
 * Upstream frontmatter is "YAML-ish but not YAML": quoted descriptions contain
 * colons, em dashes and apostrophes; `audiences` is an inline array;
 * `requires` is a block sequence; `version`, `mode-default` and
 * `disable-model-invocation` are extra keys. This parser accepts that whole
 * subset and, more importantly, never fails discovery because of an unknown
 * key: anything it cannot model is preserved as a string.
 */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NORMALIZED_KEYS = ['name', 'description', 'when_to_use', 'disable-model-invocation', 'user-invocable']

/**
 * Parse a `---` fenced frontmatter block.
 * @param {string} raw - full file text.
 * @returns {{ data: Record<string, unknown>, body: string } | null}
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  if (!text.startsWith('---')) return null
  const firstBreak = text.indexOf('\n')
  if (firstBreak === -1 || text.slice(0, firstBreak).trimEnd() !== '---') return null

  const lines = text.slice(firstBreak + 1).split('\n')
  let end = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === '---') { end = i; break }
  }
  if (end === -1) return null

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  return { data: parseBlock(lines.slice(0, end)), body }
}

function parseBlock(lines) {
  const data = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i += 1; continue }
    if (/^\s/.test(line)) { i += 1; continue }
    const colon = findTopLevelColon(line)
    if (colon === -1) { i += 1; continue }
    const key = line.slice(0, colon).trim()
    if (key === '') { i += 1; continue }
    const valueText = line.slice(colon + 1).trim()
    i += 1
    if (valueText === '') {
      const nested = collectNested(lines, i)
      data[key] = nested.value
      i = nested.next
    } else {
      data[key] = parseScalar(valueText)
    }
  }
  return data
}

/** Consume an indented continuation or block sequence following `key:`. */
function collectNested(lines, start) {
  const collected = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { collected.push(line); i += 1; continue }
    if (!/^\s/.test(line)) break
    collected.push(line)
    i += 1
  }
  const meaningful = collected.filter(line => line.trim() !== '')
  if (meaningful.length === 0) return { value: '', next: i }

  if (meaningful[0].trimStart().startsWith('- ')) {
    const items = []
    for (const line of meaningful) {
      const match = line.match(/^\s*-\s+(.*)$/)
      if (match) items.push(parseScalar(match[1].trim()))
      else if (items.length > 0) items[items.length - 1] += ` ${line.trim()}`
    }
    return { value: items, next: i }
  }

  return { value: meaningful.map(line => line.trim()).join(' '), next: i }
}

/** First colon outside quotes and outside `[]` — descriptions may contain `:`. */
function findTopLevelColon(line) {
  let quote = null
  let depth = 0
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote !== null) {
      if (char === '\\' && quote === '"') { i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '[') { depth += 1; continue }
    if (char === ']') { depth -= 1; continue }
    if (char === ':' && depth === 0) return i
  }
  return -1
}

function parseScalar(text) {
  const value = text.trim()
  if (value === '') return ''
  if (isQuoted(value, '"')) return unescapeDouble(value.slice(1, -1))
  if (isQuoted(value, "'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value.startsWith('[') && value.endsWith(']')) return splitInlineList(value.slice(1, -1))
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  return value
}

function isQuoted(value, quote) {
  return value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)
}

function unescapeDouble(value) {
  return value.replace(/\\(["\\])/g, '$1').replaceAll('\\n', '\n')
}

/** Split `a, b, "c, d"` on top-level commas. */
function splitInlineList(text) {
  const items = []
  let current = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== null) {
      current += char
      if (char === '\\' && quote === '"') { current += text[i + 1] ?? ''; i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === ',') { items.push(parseScalar(current)); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') items.push(parseScalar(current))
  return items
}

/**
 * Project parsed frontmatter into the registry-facing skill fields.
 * Extra upstream keys (version, audiences, mode-default, requires, …) are
 * preserved as `metadata` so nothing is lost.
 */
export function toSkillFields(data, fallbackName) {
  const name = typeof data.name === 'string' && SKILL_NAME.test(data.name) ? data.name : fallbackName
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  const whenToUse = typeof data.when_to_use === 'string' && data.when_to_use.trim() !== ''
    ? data.when_to_use.trim()
    : undefined
  const modelInvocable = data['disable-model-invocation'] !== true && data['disable-model-invocation'] !== 'true'
  const userInvocable = data['user-invocable'] !== false && data['user-invocable'] !== 'false'
  const metadataKeys = Object.keys(data).filter(key => !NORMALIZED_KEYS.includes(key))
  const metadata = metadataKeys.length === 0
    ? undefined
    : Object.fromEntries(metadataKeys.map(key => [key, data[key]]))
  return { name, description, whenToUse, invocation: { modelInvocable, userInvocable }, metadata }
}

export { SKILL_NAME }

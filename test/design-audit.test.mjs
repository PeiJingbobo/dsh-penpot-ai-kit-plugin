import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../lib/provider.mjs'

const SCRIPT = join(PACKAGE_ROOT, 'skills-local', 'penpot-polish', 'scripts', 'auditDesignTells.js')

function runAudit(root) {
  const source = readFileSync(SCRIPT, 'utf8')
  const factory = new Function('penpot', 'penpotUtils', 'storage', source)
  return factory({ currentPage: { root } }, {}, {})
}

function shape(overrides = {}) {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    name: overrides.name ?? 'shape',
    type: 'board',
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    children: [],
    fills: [],
    tokens: {},
    shadows: [],
    clipContent: false,
    ...overrides,
  }
}

function screen(children = []) {
  return shape({
    id: 'screen', name: '33 工作日历 · 日', width: 390, height: 844,
    flex: { dir: 'column', rowGap: 16, columnGap: 0 }, children,
  })
}

function brokenTree() {
  const tiny = shape({ id: 'tiny', name: '说明', type: 'text', width: 60, height: 16, fontSize: 11, growType: 'fixed' })
  const absurd = shape({ id: 'absurd', name: '说明', type: 'text', width: 3.145e9, height: 20, fontSize: 14, growType: 'auto-width' })
  const layoutless = shape({ id: 'layoutless', name: '汇总列表', width: 350, height: 200, children: [tiny, absurd] })
  const clipped = shape({
    id: 'clipped', name: '标题行', width: 350, height: 40, clipContent: true,
    shadows: [{ color: '#1A1A1A', offsetY: 4, blur: 16 }],
    children: [shape({ id: 'btn', name: '回到今天', width: 88, height: 40, fills: [{ fillColor: '#FFFFFF' }] })],
  })
  const raw = shape({ id: 'raw', name: 'card', width: 350, height: 120, fills: [{ fillColor: '#FFFFFF' }] })
  const offGrid = shape({ id: 'offgrid', name: 'row', width: 350, height: 40, flex: { dir: 'row', rowGap: 7, columnGap: 7 } })
  const section = shape({ id: 'section', name: 'section', width: 350, height: 400, children: [layoutless, clipped] })
  const orphan = shape({ id: 'orphan', name: '工作', width: 350, height: 86 })
  return shape({
    id: 'root', name: 'Page 1', type: 'page', width: 0, height: 0,
    children: [screen([section, raw, offGrid]), orphan],
  })
}

test('audit flags the failure modes seen in the real Penpot session', () => {
  const result = runAudit(brokenTree())
  const ids = new Set(result.findings.map(finding => finding.id))
  for (const id of ['absurd-geometry', 'board-no-layout', 'orphan-root', 'tiny-text', 'clip-shadow', 'raw-fill', 'off-grid-gap']) {
    assert.ok(ids.has(id), `expected ${id} in ${[...ids].join(', ')}`)
  }
  assert.equal(result.pass, false)
  assert.ok(result.counts.P0 >= 2, JSON.stringify(result.counts))
  const absurd = result.findings.find(finding => finding.id === 'absurd-geometry')
  assert.equal(absurd.severity, 'P0')
  assert.match(absurd.detail, /3\.145e\+9|3145000000/)
})

test('a clean tree passes with no findings', () => {
  const text = shape({ id: 't1', name: '标题', type: 'text', width: 200, height: 24, fontSize: 16, growType: 'auto-width' })
  const btn = shape({ id: 'b1', name: 'button', width: 88, height: 40, fills: [], tokens: { fill: 'color.bg.default' }, flex: { dir: 'row', rowGap: 0, columnGap: 0 }, children: [text] })
  const card = shape({ id: 'c1', name: 'card', width: 350, height: 120, flex: { dir: 'column', rowGap: 16, columnGap: 0 }, fills: [], children: [btn] })
  const section = shape({ id: 's1', name: 'section', width: 350, height: 300, flex: { dir: 'column', rowGap: 24, columnGap: 0 }, children: [card] })
  const root = shape({ id: 'root', name: 'Page 1', type: 'page', width: 0, height: 0, children: [screen([section])] })
  const result = runAudit(root)
  assert.deepEqual(result.findings, [])
  assert.equal(result.pass, true)
  assert.deepEqual(result.counts, { P0: 0, P1: 0, P2: 0 })
})

test('audit output stays bounded and actionable', () => {
  const children = Array.from({ length: 40 }, (_, i) => shape({ id: `s${i}`, name: `section-${i}`, width: 350, height: 100 }))
  const root = shape({ id: 'root', name: 'Page 1', type: 'page', width: 0, height: 0, children: [screen(children)] })
  const result = runAudit(root)
  assert.ok(result.findings.length <= 60)
  assert.ok(result.findings.every(finding => typeof finding.fix === 'string' && finding.fix.length > 0))
  assert.ok(result.findings.every(finding => finding.id && finding.severity && finding.detail))
})

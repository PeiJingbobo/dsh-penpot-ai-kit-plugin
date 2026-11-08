/**
 * auditDesignTells.js — read-only quality audit for an existing Penpot screen.
 *
 * Paste this whole file into `execute_code`. It returns:
 *   { pass, counts: { P0, P1, P2 }, findings: [...], summary: {...} }
 *
 * `pass` is true only when there are no P0 findings. Every finding carries a
 * stable `id`, a severity, the offending shape and a concrete fix. The audit is
 * deliberately bounded (8 examples per id, 60 findings total) so it stays cheap
 * to run after every section.
 *
 * Why these checks: they are the failure modes that actually broke a real
 * production session — a text whose width grew to 3.145e9 and blocked saving,
 * boards built without a layout, cards reattached to the page root, shadows
 * clipped by an over-eager `clipContent`, 11-12px text, raw white fills, and
 * gaps off the 4px grid.
 */

const GRID = 4
const ABSURD = 10_000
const MIN_TEXT = 12
const MAX_PER_ID = 8
const MAX_TOTAL = 60

const root = penpot.currentPage.root
const findings = []
const counts = { P0: 0, P1: 0, P2: 0 }
const perId = {}

const isBoard = shape => shape !== undefined && shape !== null && (shape.type === 'board' || shape.type === 'frame')
const kids = shape => (Array.isArray(shape?.children) ? shape.children : [])
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const label = shape => shape?.name || shape?.id || '(unnamed)'
const isExemptClip = name => /mask|scroll|carousel|image|photo|遮罩|滚动|轮播/i.test(String(name ?? ''))
const FIXES = {
  'absurd-geometry': 'Resize or delete the shape; a valid UI shape is between 1 and 10000 px on each axis.',
  'board-no-layout': 'Call addFlexLayout() (or addGridLayout()) before appending children, then set gaps/alignment.',
  'orphan-root': 'Reparent the shape into the correct screen frame (or delete it). Page-root children are not part of a screen.',
  'tiny-text': `Raise fontSize to the body/caption token (>= ${MIN_TEXT}px); update the token, not just this instance.`,
  'clip-shadow': 'Set clipContent=false on decorative containers; keep true only on the outer frame, masks and scroll containers.',
  'raw-fill': 'Clear the default white fill on structural boards, or bind a color.bg.* token on surfaces.',
  'pure-color': 'Use near-black/near-white neutrals from the token ramp instead of #000000/#FFFFFF.',
  'off-grid-gap': `Snap rowGap/columnGap to the ${GRID}px scale; use the spacing tokens.`,
  'mixed-radius': 'Pick one radius family for the screen (control vs card vs pill) and apply it everywhere.',
  'uniform-gap': 'Use the gap ladder: 4-8 inside a control, 8-12 between related items, 16-24 between cards, 48-64 between sections.',
  'equal-triplets': 'Three identical siblings read as a template. Use unequal spans, an asymmetric pair, or a different block.',
}

function report(id, severity, shape, detail) {
  if (findings.length >= MAX_TOTAL) return
  perId[id] = (perId[id] || 0) + 1
  if (perId[id] > MAX_PER_ID) return
  findings.push({ id, severity, shape: label(shape), detail, fix: FIXES[id] || 'Inspect and fix this shape.' })
  counts[severity] += 1
}

const flat = []
function walk(shape, parent, depth) {
  flat.push({ shape, parent, depth })
  for (const child of kids(shape)) walk(child, shape, depth + 1)
}
walk(root, undefined, 0)

// Bottom-up shadow presence: a child's shadow can be clipped by its parent.
const shadowInSubtree = new Map()
function computeShadow(shape) {
  let found = Array.isArray(shape?.shadows) && shape.shadows.length > 0
  for (const child of kids(shape)) if (computeShadow(child)) found = true
  shadowInSubtree.set(shape, found)
  return found
}
computeShadow(root)

const radii = new Set()
const flexGaps = []

for (const { shape, parent } of flat) {
  if (shape === root) continue
  const width = num(shape.width)
  const height = num(shape.height)

  if (width === undefined || height === undefined || width < 1 || height < 1 || width > ABSURD || height > ABSURD) {
    report('absurd-geometry', 'P0', shape, `width=${width ?? '?'} height=${height ?? '?'} — invalid or int32-risky geometry`)
    continue
  }

  if (isBoard(shape) && !shape.flex && !shape.grid) {
    report('board-no-layout', 'P0', shape, 'board has neither flex nor grid layout')
  }

  if (shape.type === 'text' && num(shape.fontSize) !== undefined && shape.fontSize < MIN_TEXT) {
    report('tiny-text', 'P1', shape, `fontSize ${shape.fontSize}px is below the ${MIN_TEXT}px floor`)
  }

  if (isBoard(shape) && shape.clipContent === true && shadowInSubtree.get(shape) && !isExemptClip(shape.name)) {
    report('clip-shadow', 'P1', shape, 'clipContent=true on a container whose subtree has shadows')
  }

  const fills = Array.isArray(shape.fills) ? shape.fills : []
  if ((isBoard(shape) || shape.type === 'rect') && fills.length > 0 && !(shape.tokens && shape.tokens.fill)) {
    report('raw-fill', 'P1', shape, 'fill without a color token (possibly the default opaque white)')
  }
  for (const fill of fills) {
    if (fill && typeof fill.fillColor === 'string' && /^#(?:000000|ffffff)$/i.test(fill.fillColor)) {
      report('pure-color', 'P1', shape, `pure ${fill.fillColor.toUpperCase()} fill`)
    }
  }

  if (num(shape.borderRadius) !== undefined && shape.borderRadius > 0) radii.add(shape.borderRadius)

  for (const layout of [shape.flex, shape.grid]) {
    if (!layout) continue
    for (const key of ['rowGap', 'columnGap']) {
      const gap = num(layout[key])
      if (gap === undefined) continue
      flexGaps.push(gap)
      if (gap % GRID !== 0) report('off-grid-gap', 'P1', shape, `${key}=${gap} is off the ${GRID}px grid`)
    }
  }
}

// Page-root children that are not screen-sized frames are almost always
// leftovers from a failed reparent (cards duplicated onto the root).
for (const child of kids(root)) {
  if (isBoard(child) && num(child.width) >= 300 && num(child.height) >= 300) continue
  report('orphan-root', 'P0', child, `direct child of page root (${num(child.width) ?? '?'}x${num(child.height) ?? '?'})`)
}

if (radii.size > 2) {
  findings.push({
    id: 'mixed-radius', severity: 'P2', shape: '(screen)',
    detail: `${radii.size} distinct corner radii: ${[...radii].sort((a, b) => a - b).join(', ')}`,
    fix: FIXES['mixed-radius'],
  })
  counts.P2 += 1
}
if (flexGaps.length >= 5 && new Set(flexGaps).size === 1) {
  findings.push({
    id: 'uniform-gap', severity: 'P2', shape: '(screen)',
    detail: `every flex container uses the same gap (${flexGaps[0]}px); no proximity hierarchy`,
    fix: FIXES['uniform-gap'],
  })
  counts.P2 += 1
}

// Three identical siblings in one row: the classic equal-trip card row.
for (const { shape } of flat) {
  const boards = kids(shape).filter(isBoard)
  if (boards.length < 3) continue
  const buckets = new Map()
  for (const board of boards) {
    const key = `${Math.round(num(board.width) ?? 0)}x${Math.round(num(board.height) ?? 0)}`
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }
  const triplet = [...buckets.entries()].find(([, count]) => count >= 3)
  if (triplet) report('equal-triplets', 'P2', shape, `3+ identical ${triplet[0]} siblings under one parent`)
}

return {
  pass: counts.P0 === 0,
  counts,
  findings,
  summary: {
    shapes: flat.length,
    boards: flat.filter(entry => isBoard(entry.shape)).length,
    texts: flat.filter(entry => entry.shape.type === 'text').length,
    screens: kids(root).filter(child => isBoard(child) && num(child.width) >= 300 && num(child.height) >= 300).length,
  },
}

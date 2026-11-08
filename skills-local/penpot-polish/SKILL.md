---
name: penpot-polish
description: "Audit and fix an existing Penpot screen or component that is already built but looks broken or unpolished: overlap, clipping, overflow, tiny text, orphan shapes on the page root, layout-less boards, raw fills, off-grid gaps, or a save blocked by absurd geometry. Use when the user says 修一下 / 检查 UI / 错误百出 / doesn't look right, or after a build before declaring done. Read-only audit first, then P0 fixes, re-audit, max 2 passes, before/after exports."
version: 0.1.0
audiences: [product-designer, design-engineer]
mode-default: review
---

# penpot-polish — diagnose, then fix broken UI

Use this when the screen already exists. Do not restart the design or rebuild the
page from scratch; find the concrete defects, fix the blocking ones, and prove
the fix with a re-audit and an export.

## 0. The rule

**Audit first, then fix P0 before P1.** One defect class per `execute_code` call,
re-audit after each pass, and stop after **2 passes**. A rebuild is a different
task (`penpot-build-screen`), not this skill.

## 1. Run the read-only audit

1. Read `scripts/auditDesignTells.js` from this skill's base directory.
2. Paste the **whole file** into `execute_code` (it is self-contained; no imports).
3. Read the returned `{ pass, counts, findings, summary }`.

The audit is read-only. It checks the failure modes that broke a real production
session:

| id | severity | meaning |
|---|---|---|
| `absurd-geometry` | P0 | width/height < 1 or > 10000 (a 3.145e9 text width once blocked saving the file) |
| `board-no-layout` | P0 | a board/frame has neither flex nor grid |
| `orphan-root` | P0 | a non-screen child sits directly on the page root (reattached orphan) |
| `clip-shadow` | P1 | `clipContent=true` on a container whose subtree has shadows |
| `tiny-text` | P1 | `fontSize` below 12px |
| `raw-fill` | P1 | a fill with no color token (often the default opaque white) |
| `pure-color` | P1 | literal `#000000` / `#FFFFFF` |
| `off-grid-gap` | P1 | flex/grid gap not on the 4px grid |
| `mixed-radius` | P2 | more than two corner radii in one screen |
| `uniform-gap` | P2 | every flex container uses the same gap |
| `equal-triplets` | P2 | three identical siblings under one parent |

`pass` is true only when there are no P0 findings. The output is bounded to 60
findings (8 examples per id), so it is cheap enough to run after every section.

Make sure the right page is open before running: `penpot.currentPage.root` is the
audit root.

## 2. Fix order (never skip ahead)

**P0 — blocking; fix before any visual tweak.**

- `absurd-geometry`: inspect the shape. For text, set `growType = "auto-width"`
  (or `auto-height`), then `resize()` to a sane width; re-read width. If the bad
  geometry survives, delete and recreate that text. Re-run the audit; if a save
  is already failing, this is the first thing to clear.
- `board-no-layout`: call `addFlexLayout()` (or `addGridLayout()`) **before**
  appending children. If the board already has children, use
  `penpotUtils.addFlexLayout(container, dir)` to preserve their order. A plain
  Group is not a container — wrap it in a Board.
- `orphan-root`: reparent the shape into the screen frame it belongs to, or
  delete it if it is a leftover duplicate. Then assert the page root has only
  screen-sized frames.

**P1 — visible defects; fix in the order reported.**

- `clip-shadow`: set `clipContent = false` on decorative containers. Keep `true`
  only on the outer screen frame, image/text masks, scroll containers and pill
  containers that genuinely clip. A parent clipping a child's shadow is a bug.
- `tiny-text`: raise to the body/caption token (≥ 12px, preferably ≥ 14px in this
  app) and fix the token, not only this instance.
- `raw-fill`: a structural board gets `fills = []`; a surface binds a
  `color.bg.*` token. Never leave Penpot's default opaque white on a wrapper.
- `off-grid-gap`: snap to the 4px scale (`4/8/12/16/24/32/48/64`) or bind the
  spacing token.

**P2 — taste; fix only after P0/P1 are clean.**

`mixed-radius`: one radius family per screen. `uniform-gap`: apply the gap
ladder (4-8 inside a control, 8-12 related, 16-24 cards, 48-64 sections).
`equal-triplets`: make the spans unequal or choose a different block.

## 3. Re-audit and bound the loop

- Re-run the **same script** after each fix pass.
- Report the before/after counts (`P0/P1/P2`) and the ids fixed.
- **Maximum 2 passes.** If a P0 still remains, stop and present the export with
  the remaining findings named. Never silently accept it, never loop forever.

## 4. Visual confirmation

Export the affected screen (or the smallest changed frame) with `export_shape`
and look at it. Check overlap, clipping at board edges, text overflow, hierarchy
and spacing. Fix only the defect you can see, then re-export. Do not present an
unlooked-at image.

## 5. Report

Return a compact table: audit counts before → after, fixed ids, remaining ids
with the reason they were left. Name the shapes you touched. If nothing was
fixed because the audit passed, say so with the counts.

## Anti-rationalization

| Excuse | Why it's wrong | Countermeasure |
|---|---|---|
| "It looks fine on the canvas." | Canvas zoom hides overlap, clipped shadows and text overflow. | Run the audit and export the frame; both are cheap. |
| "I'll rebuild the screen, faster than fixing." | Rebuilds re-introduce the same defects and lose user-approved details. | Fix P0/P1 in place; rebuild only when the user asks. |
| "One more pass will fix it." | Unbounded loops burn the turn and hide a wrong approach. | Hard stop at 2 passes; report the remainder. |
| "The 11px label is a caption, it's fine." | Below the floor is a legibility defect, and the token is wrong everywhere. | Fix the token and every instance. |
| "The white fill is harmless." | It is Penpot's default, not a decision; it breaks dark mode and rounded corners. | Clear it on wrappers or bind a token on surfaces. |

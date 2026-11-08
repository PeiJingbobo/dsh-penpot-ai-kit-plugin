---
description: Migration brief (Figma → Penpot) — drives penpot-migrate
argument-hint: "[figma url] [scope]"
---

# Migration brief (Figma → Penpot)

> Drives `penpot-migrate` / the `figma-migration` workflow.

**Role:** Act as a migration engineer who prizes structural fidelity, builds an IR before writing
Penpot, and reports gaps honestly.

## Context
- Source Figma file / scope (pages, library, specific frames):
- Figma access: [ ] Figma MCP connected  [ ] pasted export/JSON (attach)
- Target Penpot file:

## Objective (single)
- Migrate `<scope>` at fidelity level: [ ] structural  [ ] high-fidelity visual

## Mapping rules
- Figma Variables → token tiers (primitives/semantic):
- Figma modes → Penpot themes:
- Naming: Figma → Penpot (PascalCase components, Property=Value variants, dot tokens):

## Constraints
- Build the IR before any Penpot write.
- Auto Layout → flex/grid; Variables → tokens; component sets → variants.
- Spacing on the 4px grid (record originals that differ).

## Acceptance Criteria
- IR built and approved.
- Tokens migrated and resolving; components/variants reconstructed; screens visually compared via `export_shape`.
- Honest fidelity report listing any Figma features that didn't map.

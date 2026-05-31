# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static commutative algebra learning app deployed on GitHub Pages (`lukemartinetz-cell/Mathweb`, main branch). No build step — edited files go live after `git push`. The entire data layer is `concepts.json`.

## Common commands

```powershell
# Generate a new concept entry (requires ANTHROPIC_API_KEY)
$env:ANTHROPIC_API_KEY = "sk-ant-..."; node generate.js "ring homomorphism"
node generate.js --dry-run "ring homomorphism"   # preview without writing
node generate.js --verbose "ring homomorphism"   # show all phase outputs

# Delete a concept entry
node delete.js "concept-id"
node delete.js --dry-run "concept-id"
```

There are no tests, no linter, and no build process.

## Architecture

### Data
`concepts.json` is the single source of truth — one flat array of concept objects. Every view fetches it directly from the same origin. Three entry types:

- **Full concept**: has `page.blocks[]` with content, `refs[]` for dependencies, `inline` HTML with `<span class="t" data-ref="...">` clickable terms, and `generated: "YYYY-MM-DD"` (set at generation time)
- **Stub**: `stub: true`, empty `page.blocks[]`, plain-text `inline` (no `data-ref` spans), empty `refs[]` — exists only so clickable terms in full concepts have something to expand to
- **Alias**: `{ id, alias_of, inline }` — maps a word form (e.g. "quotient rings") to its canonical entry

### Two independent reference systems
- **`refs[]`** — drives the quiz algorithm (dependency graph) and the graph/tree visualisations. Only `type: "required"` entries create edges in the graph.
- **`data-ref` spans in HTML** — drives clickable inline expansions. Stubs exist precisely to back these spans.

These two systems are separate: a concept can be in `refs[]` without appearing as a `data-ref` span and vice versa. `delete.js` and `generate.js` scan both independently.

### Views
All views are self-contained HTML files sharing no JS modules:
- `app.html` — nav bar + concept reader (index.html redirects here)
- `tree.html` — D3 radial tree centred on selected concept; left panel = tree, right panel = concept content
- `graph.html` — D3 force-directed graph of all full concepts + stubs with dependency edges. Uses a topology-aware layout: `computeDepths` runs Kahn's topological sort + longest-path propagation on the link list to assign each node a depth, then `forceY` pulls connected nodes toward their depth band (foundational concepts near top, advanced near bottom). Isolated nodes (no edges) get `forceY` strength 0 so repulsion scatters them naturally instead of bunching them in a line.
- `learn.html` — three-phase quiz: select target → quiz prerequisites → reading list
- `learn-visual.html` — same quiz but with live D3 graph panel alongside

`renderBlock`, `processRefs`, `handleRefClick`, `typeset`, and `toggleProof` are duplicated across all views — edit all four when changing shared rendering logic.

All views support dark mode: a `.dm` class on `<html>` is toggled by `toggleTheme()` and persisted in `localStorage('theme')`; the initial value also respects `prefers-color-scheme`. When adding new UI elements, add corresponding `html.dm` CSS rules in every view.

### generate.js pipeline (3 LLM calls + post-processing + validation)
P1 calls `claude-opus-4-7` with adaptive extended thinking; P2 and P3 are plain calls (no thinking).

1. **P1** — generates raw content (title, inline, sections) as plain text + LaTeX + `{ref:id}` notation markers. Strips unknown marker IDs before proceeding.
2. **P2** — detects concept references in the plain text; returns `word/id/inline` triples. Provides `inline` text for stubs and new concepts. Builds `p2InlineMap` used in stub creation.
3. **P3** — classifies each ref as `required` or `enriches`. `required` applies when the concept is the IS-A parent type of what's being defined ("X is a Y" → Y is required) or a core definitional ingredient; everything else is `enriches`. Cycles in the required graph are prevented here.
4. **IS-A safety net** — deterministic post-P3 pass: scans the raw def text (LaTeX stripped) for the pattern `(is|are|be) + up to 4 words + ref-word` and promotes any matching `enriches` ref to `required`, subject to the cycle rule and 10-ref cap. Catches IS-A misclassifications the LLM might miss.
5. **P4** — deterministic HTML assembly: `wrapRefs` wraps matched words with `<span class="t" data-ref="...">`, `resolveNotationRefs` converts `{ref:id}` markers on LaTeX expressions. Block labels and proof fields are attached here via `assembleBlocks`.
6. **Validation** — checks for unknown `data-ref` IDs, unknown `refs[]` IDs, cycle detection.

After writing, stubs are auto-created for any `data-ref` ID not yet in the file, using inline text from `p2InlineMap`. If `p2InlineMap` has no entry for a `data-ref` ID, the stub is not created (logged as a warning).

Blocks can carry an optional `proof` string (continuous LaTeX prose, no step numbers) attached in `assembleBlocks` from `sections.def_proof`, `sections.equiv_proof`, or `sections.prop_proof`. Rendered as a hidden toggle in all views via `toggleProof()`.

### delete.js algorithm
1. Collect outgoing IDs (from `refs[]` + `data-ref` spans) before any modification.
2. Check if target or any of its aliases is referenced elsewhere — if so, demote to stub (strip `data-ref` spans from inline via `stripDataRefSpans`, clear `refs[]` and `page`).
3. If not referenced, delete target and its aliases.
4. Cascade: for each outgoing stub that is now unreferenced, delete it (and its aliases). Cascade is always depth-1 because stubs have no outgoing references.

### Invariant
The file should always be in a state that could have been produced by `generate.js` alone (never deleting). Stubs always have a real `inline` from Phase 2 — the placeholder text `"(Not yet defined.)"` must never appear.

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCEPTS_PATH = join(__dirname, 'concepts.json');

// ── Helpers ───────────────────────────────────────────────────────────────

function isStubLike(c) {
  return c.stub === true || !c.page?.blocks?.length;
}

function isAlias(c) {
  return typeof c.alias_of === 'string';
}

function extractDataRefs(html) {
  const ids = [], re = /data-ref="([^"]+)"/g;
  let m;
  while ((m = re.exec(html ?? '')) !== null) ids.push(m[1]);
  return ids;
}

function allHtmlStrings(concept) {
  const out = [concept.inline];
  for (const b of concept.page?.blocks ?? []) {
    if (b.body) out.push(b.body);
    for (const s of b.steps ?? []) out.push(s);
    for (const item of b.items ?? []) out.push(item);
  }
  return out.filter(Boolean);
}

// Removes <span class="t" data-ref="...">...</span> wrappers, leaving inner text/LaTeX intact.
function stripDataRefSpans(html) {
  if (!html) return html;
  return html.replace(/<span class="t" data-ref="[^"]+">([\s\S]*?)<\/span>/g, '$1');
}

// All IDs that a concept points to — union of refs[] and all data-ref spans.
function getOutgoingIds(concept) {
  const ids = new Set();
  for (const r of concept.refs ?? []) ids.add(r.id);
  for (const html of allHtmlStrings(concept))
    for (const id of extractDataRefs(html)) ids.add(id);
  return ids;
}

// Returns true if `id` appears in any concept's refs[] or data-ref spans.
function isReferencedIn(id, concepts) {
  for (const c of concepts) {
    if (c.refs?.some(r => r.id === id)) return true;
    for (const html of allHtmlStrings(c))
      if (extractDataRefs(html).includes(id)) return true;
  }
  return false;
}

function removeById(concepts, id) {
  const idx = concepts.findIndex(c => c.id === id);
  if (idx !== -1) concepts.splice(idx, 1);
}

// Deletes all aliases of a canonical ID. Returns the deleted aliases.
function removeAliasesOf(concepts, canonicalId, log = true) {
  const aliases = concepts.filter(c => isAlias(c) && c.alias_of === canonicalId);
  for (const a of aliases) {
    removeById(concepts, a.id);
    if (log) console.log(`  - Deleted alias "${a.id}" → "${canonicalId}"`);
  }
  return aliases;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function deleteConcept(targetId, { dryRun = false } = {}) {
  const data = JSON.parse(await readFile(CONCEPTS_PATH, 'utf8'));
  const concepts = data.concepts;

  const targetIdx = concepts.findIndex(c => c.id === targetId);
  if (targetIdx === -1) {
    console.error(`Error: "${targetId}" not found in concepts.json.`);
    process.exit(1);
  }

  const target = concepts[targetIdx];
  let demoted = 0, deleted = 0, cascaded = 0;

  // ── Special case: alias ───────────────────────────────────────────────────
  if (isAlias(target)) {
    console.log(`  - Deleted alias "${targetId}" → "${target.alias_of}"`);
    deleted++;
    if (!dryRun) {
      removeById(concepts, targetId);
      await writeFile(CONCEPTS_PATH, JSON.stringify(data, null, 2), 'utf8');
    }
    if (dryRun) console.log('\n[dry-run] No changes written.');
    console.log(`\nDone. Deleted ${deleted} alias.`);
    return;
  }

  // ── Step 1: collect outgoing IDs before modifying ─────────────────────────
  const candidates = getOutgoingIds(target);

  // ── Step 2: determine whether X must stay as a stub ──────────────────────
  // "others" excludes X itself and its own aliases (those leave with X if deleted).
  const ownAliases    = concepts.filter(c => isAlias(c) && c.alias_of === targetId);
  const ownAliasIds   = new Set(ownAliases.map(a => a.id));
  const others        = concepts.filter(c => c.id !== targetId && !ownAliasIds.has(c.id));

  // X must be kept as a stub if its own ID OR any alias ID is referenced elsewhere —
  // deleting X would also delete its aliases, breaking any data-ref spans for them.
  const xReferenced     = isReferencedIn(targetId, others);
  const aliasReferenced = ownAliases.some(a => isReferencedIn(a.id, others));
  const mustKeep        = xReferenced || aliasReferenced;

  // ── Step 3: demote or delete X ────────────────────────────────────────────
  const alreadyStub = isStubLike(target);

  if (mustKeep) {
    if (alreadyStub) {
      console.log(`  ~ Kept stub  "${target.title}" (${targetId}) — still referenced`);
    } else {
      console.log(`  ↓ Demoted   "${target.title}" (${targetId}) to stub`);
      if (!xReferenced && aliasReferenced)
        console.log(`    (kept because alias is referenced by other entries)`);
      demoted++;
      if (!dryRun) {
        concepts[targetIdx] = {
          stub:   true,
          id:     target.id,
          title:  target.title,
          inline: stripDataRefSpans(target.inline),
          refs:   [],
          page:   { blocks: [], related: [] },
        };
      }
    }
  } else {
    console.log(`  - Deleted   "${target.title}" (${targetId})`);
    deleted++;
    if (!dryRun) {
      removeById(concepts, targetId);
      removeAliasesOf(concepts, targetId);
    } else {
      for (const a of ownAliases)
        console.log(`  - Deleted alias "${a.id}" → "${targetId}"`);
    }
  }

  // ── Step 4: cascade — check candidate stubs ───────────────────────────────
  // Stubs reference nothing (empty refs[], plain-text inline), so cascade is depth-1.
  for (const candidateId of candidates) {
    const c = concepts.find(c => c.id === candidateId);
    if (!c || !isStubLike(c) || isAlias(c)) continue;

    // Check against the current state of concepts[] — reflects X's demotion/deletion
    // and any stubs already removed in this loop.
    const remaining = concepts.filter(c => c.id !== candidateId);
    if (!isReferencedIn(candidateId, remaining)) {
      console.log(`  - Deleted stub "${candidateId}" — no longer referenced`);
      cascaded++;
      if (!dryRun) {
        removeById(concepts, candidateId);
        removeAliasesOf(concepts, candidateId);
      } else {
        const stubAliases = concepts.filter(a => isAlias(a) && a.alias_of === candidateId);
        for (const a of stubAliases)
          console.log(`  - Deleted alias "${a.id}" → "${candidateId}"`);
      }
    } else {
      console.log(`  ~ Kept stub   "${candidateId}" — still referenced elsewhere`);
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  if (!dryRun) {
    await writeFile(CONCEPTS_PATH, JSON.stringify(data, null, 2), 'utf8');
  } else {
    console.log('\n[dry-run] No changes written.');
  }

  const parts = [
    demoted  ? `demoted ${demoted} to stub` : '',
    deleted  ? `deleted ${deleted}` : '',
    cascaded ? `cascade-deleted ${cascaded} stub${cascaded !== 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  console.log(`\nDone.${parts.length ? ' ' + parts.join(', ') + '.' : ''}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const flags  = new Set(args.filter(a => a.startsWith('--')));
const id     = args.find(a => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');

if (!id) {
  console.error('Usage: node delete.js [--dry-run] "<concept-id>"');
  process.exit(1);
}

deleteConcept(id, { dryRun }).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCEPTS_PATH = join(__dirname, 'concepts.json');
const client = new Anthropic();

// ── System prompts ────────────────────────────────────────────────────────

const SYS_P1 = `You generate rigorous mathematical content for a commutative algebra learning app (Altman & Kleiman).

Output a single JSON object — NO HTML, NO <span> tags, NO data-ref attributes. Plain text with LaTeX math only.

Schema:
{
  "id": "kebab-case-id",
  "title": "German title",
  "subtitle": "Chapter · Source · Topic",
  "inline": "1–3 sentence German summary. Plain text with LaTeX. No HTML.",
  "sections": {
    "why": "Motivation paragraph in German. What problem does this concept solve?",
    "def": "Precise formal definition in German.",
    "prop": "Main proposition or theorem (omit key if none).",
    "proof": ["Step 1 in German with LaTeX", "Step 2", "..."]
  }
}

Rules:
- Write in German. Formal mathematical language.
- LaTeX: inline \\( ... \\), display \\[ ... \\]. All backslashes doubled in JSON strings.
- Use \\mathfrak{a}, \\mathfrak{b} for ideals; \\mathfrak{m} for maximal ideals.
- Do NOT write any HTML tags. Do NOT link concepts. Just plain text + LaTeX.
- Omit "prop" and "proof" keys entirely if not applicable.
- proof is an array of step strings, not a single string.
- Output only JSON, no markdown fences.`;

const SYS_P2 = `You identify mathematical concept references in German mathematical text.

Given: plain text + a pool of known concept IDs with titles.

Output a single JSON object:
{
  "refs": [
    { "word": "Ring", "id": "ring", "new": false },
    { "word": "Quotientenring", "id": "quotient-ring", "new": false,
      "alias_id": "quotientenring",
      "alias_inline": "Ein Quotientenring ist ein Ring der Form \\\\(R/\\\\mathfrak{a}\\\\)." },
    { "word": "neue Struktur", "id": "neue-struktur", "new": true,
      "inline": "Eine neue Struktur ist eine Menge mit..." }
  ]
}

Field meanings:
- word: exact phrase (base/uninflected form) as it appears in the text
- id: canonical concept ID — use the existing pool ID if the concept exists, otherwise propose a new kebab-case ID
- new: true ONLY when the concept genuinely does not exist anywhere in the pool
- alias_id: (optional) if the word is a German synonym or alternative name for an existing concept, provide a new kebab-case alias ID for this word form; keep "id" as the canonical ID
- alias_inline: (required when alias_id is set) one-sentence German definition for this word form, with LaTeX if needed
- inline: (required when new:true) one-sentence German definition for the stub, with LaTeX if needed

Classification rules:
- Only identify terms that name mathematical concepts (definitions, structures, theorems) — not generic words like "Menge", "Funktion", or "Element" unless they name a specific structure.
- Match to existing pool IDs whenever the concept is the same, even if the German phrasing differs (use alias_id for the German word form).
- Each canonical "id" appears at most ONCE in refs. Pick the most representative occurrence.
- Skip content inside LaTeX delimiters \\( \\) and \\[ \\] — identify natural-language terms only.
- Do NOT identify the concept being defined itself.
- SAME-BLOCK SUPPRESSION: If a mathematical term is explicitly defined or explained within the same sentence or paragraph where it appears, do NOT mark it as a ref. Only mark terms that the reader must already know — do not create circular references to things the text itself teaches.
- Output only JSON, no markdown fences.`;

const SYS_P3 = `You classify concept dependencies for a new mathematical concept entry.

Given:
- Core text: the inline summary and definition (these must be understandable on their own)
- Full text: all sections including motivation and examples
- Detected refs: list of {id, word} pairs (canonical IDs)
- Existing required-dependency graph: which concepts already require which

Output a single JSON object:
{
  "refs": [
    { "id": "concept-id", "type": "required" },
    { "id": "concept-id", "type": "enriches" }
  ]
}

Classification rules:
- "required": concept appears in inline or def/proof AND the entry cannot be read without it.
- "enriches": concept appears ONLY in the why/motivation block or a worked example.
- Each ID appears at most once in refs[].
- CYCLE RULE: if concept B already requires concept A (directly or transitively), do NOT classify A as "required" here — use "enriches" instead to avoid mutual required dependencies.
- Max 10 required refs. Demote the least essential ones to "enriches" if over limit.
- Output only JSON, no markdown fences.`;

// ── Helpers ───────────────────────────────────────────────────────────────

function isStubLike(c) {
  return c.stub === true || !c.page?.blocks?.length;
}

function isAlias(c) {
  return typeof c.alias_of === 'string';
}

function parseJSON(raw) {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fence ? fence[1] : raw).trim());
}

async function callClaude(system, user, { thinking = false, maxTokens = 4000 } = {}) {
  const params = {
    model: 'claude-opus-4-7',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (thinking) params.thinking = { type: 'adaptive' };
  const stream = client.messages.stream(params);
  const msg = await stream.finalMessage();
  const block = msg.content.find(b => b.type === 'text');
  if (!block) throw new Error('No text block in Claude response');
  return block.text.trim();
}

// ── Phase 4 utilities: HTML assembly ─────────────────────────────────────

// Unicode-aware word boundaries: treat German umlauts and ß as word characters.
// JavaScript's \b only recognises [a-zA-Z0-9_], so Ä, ö, ü etc. break boundaries.
const WB_L = String.raw`(?<![a-zA-ZÄÖÜäöüß0-9_])`;
const WB_R = String.raw`(?![a-zA-ZÄÖÜäöüß0-9_])`;

// Split text into [{ text, latex }] segments so replacements skip LaTeX regions.
function tokenizeLatex(text) {
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const il = text.indexOf('\\(', i);
    const dl = text.indexOf('\\[', i);
    let next = -1, end = '';
    if (il !== -1 && (dl === -1 || il <= dl)) { next = il; end = '\\)'; }
    else if (dl !== -1) { next = dl; end = '\\]'; }
    if (next === -1) { segs.push({ text: text.slice(i), latex: false }); break; }
    if (next > i) segs.push({ text: text.slice(i, next), latex: false });
    const ei = text.indexOf(end, next + 2);
    if (ei === -1) { segs.push({ text: text.slice(next), latex: false }); break; }
    segs.push({ text: text.slice(next, ei + end.length), latex: true });
    i = ei + end.length;
  }
  return segs;
}

// Wrap concept occurrences with <span class="t" data-ref="..."> tags.
// For alias refs, uses ref.alias_id for the data-ref attribute (canonical ref.id
// goes into refs[] for dependency tracking; alias_id is what the browser looks up).
// Longest phrases processed first; LaTeX regions are skipped.
function wrapRefs(text, refList) {
  if (!text || !refList.length) return text;
  const sorted = [...refList].sort((a, b) => b.word.length - a.word.length);
  const segs = tokenizeLatex(text);

  const hits = [];
  let offset = 0;
  for (const seg of segs) {
    if (seg.latex) { offset += seg.text.length; continue; }
    for (const ref of sorted) {
      const esc = ref.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let re;
      try { re = new RegExp(`${WB_L}${esc}${WB_R}`, 'gi'); }
      catch { re = new RegExp(esc, 'gi'); }
      let m;
      while ((m = re.exec(seg.text)) !== null) {
        const s = offset + m.index, e = s + m[0].length;
        if (!hits.some(h => h.s < e && h.e > s))
          // Use alias_id for the data-ref attribute when present
          hits.push({ s, e, id: ref.alias_id ?? ref.id, match: m[0] });
      }
    }
    offset += seg.text.length;
  }

  hits.sort((a, b) => b.s - a.s);
  let out = text;
  for (const h of hits)
    out = out.slice(0, h.s)
      + `<span class="t" data-ref="${h.id}">${h.match}</span>`
      + out.slice(h.e);
  return out;
}

function plainToHtml(text) {
  if (!text) return '';
  return text.replace(/\n\n/g, '<br><br>').replace(/\n(?!\n)/g, ' ').trim();
}

function assembleBlocks(sections, refList) {
  const blocks = [];
  if (sections?.why) blocks.push({
    type: 'why', label: 'Motivation',
    body: wrapRefs(plainToHtml(sections.why), refList),
  });
  if (sections?.def) blocks.push({
    type: 'def', label: 'Definition',
    body: wrapRefs(plainToHtml(sections.def), refList),
  });
  if (sections?.prop) blocks.push({
    type: 'prop', label: 'Proposition',
    body: wrapRefs(plainToHtml(sections.prop), refList),
  });
  if (sections?.proof?.length) blocks.push({
    type: 'proof', label: 'Beweis',
    steps: sections.proof.map(s => wrapRefs(plainToHtml(s), refList)),
  });
  return blocks;
}

// ── Graph utilities ───────────────────────────────────────────────────────

function buildRequiredGraph(concepts) {
  const g = new Map();
  for (const c of concepts)
    g.set(c.id, new Set((c.refs ?? []).filter(r => r.type === 'required').map(r => r.id)));
  return g;
}

function canReach(graph, from, to, visited = new Set()) {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  for (const dep of graph.get(from) ?? [])
    if (canReach(graph, dep, to, visited)) return true;
  return false;
}

function findCycles(graph) {
  const cycles = [];
  for (const [id, deps] of graph)
    for (const dep of deps)
      if (canReach(graph, dep, id))
        cycles.push([id, dep]);
  return cycles;
}

// ── Extract data-ref IDs ──────────────────────────────────────────────────

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
  }
  return out.filter(Boolean);
}

// ── Stub / alias factories ────────────────────────────────────────────────

function makeStub(id, title, inline) {
  return {
    stub: true, id,
    title: title || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    subtitle: 'Algebra · Ringtheorie',
    inline: inline || '(Noch nicht definiert.)',
    refs: [],
    page: { blocks: [], related: [] },
  };
}

function makeAlias(id, alias_of, inline) {
  return { id, alias_of, inline: inline || '' };
}

// ── Phase 5: Validation ───────────────────────────────────────────────────

function validate(concept, data) {
  const issues = [];
  const knownIds = new Set(data.concepts.map(c => c.id));
  knownIds.add(concept.id);

  for (const html of allHtmlStrings(concept))
    for (const id of extractDataRefs(html))
      if (!knownIds.has(id)) issues.push(`Unknown data-ref "${id}"`);

  for (const r of concept.refs ?? [])
    if (!knownIds.has(r.id)) issues.push(`Unknown refs[] ID "${r.id}"`);

  const refSet = new Set((concept.refs ?? []).map(r => r.id));

  const reqCount = (concept.refs ?? []).filter(r => r.type === 'required').length;
  if (reqCount > 10) issues.push(`${reqCount} required refs (max 10)`);

  const graph = buildRequiredGraph(data.concepts);
  graph.set(concept.id, new Set(
    (concept.refs ?? []).filter(r => r.type === 'required').map(r => r.id)
  ));
  for (const [a, b] of findCycles(graph))
    issues.push(`Cycle: "${a}" ↔ "${b}" mutually required`);

  return issues;
}

// ── Main pipeline ─────────────────────────────────────────────────────────

async function generateConcept(topic, { dryRun = false, verbose = false } = {}) {
  const data = JSON.parse(await readFile(CONCEPTS_PATH, 'utf8'));

  const fullConcepts = data.concepts.filter(c => !isStubLike(c) && !isAlias(c));
  const stubConcepts = data.concepts.filter(c => isStubLike(c) && !isAlias(c));
  const fullList = fullConcepts.map(c => `  ${c.id}: ${c.title}`).join('\n') || '  (none)';
  const stubList = stubConcepts.map(c => `  ${c.id}: ${c.title}`).join('\n') || '  (none)';
  const allList  = data.concepts.map(c => c.alias_of
    ? `  ${c.id} [alias→${c.alias_of}]: ${c.title || c.id}`
    : `  ${c.id}: ${c.title}`
  ).join('\n') || '  (none)';

  const topicLower = topic.toLowerCase();
  const existingMatch = stubConcepts.find(c =>
    c.id === topicLower.replace(/\s+/g, '-') ||
    c.title?.toLowerCase() === topicLower ||
    c.title?.toLowerCase().includes(topicLower) ||
    topicLower.includes(c.title?.toLowerCase())
  );
  const upgradeHint = existingMatch
    ? `\nExisting stub "${existingMatch.id}" (${existingMatch.title}) matches — use that exact ID.`
    : '';

  // ── Phase 1: Content ────────────────────────────────────────────────────
  console.log(`\n[P1] Generating content for "${topic}"...`);

  const p1Raw = await callClaude(SYS_P1,
    `Full concepts (do not regenerate):\n${fullList}\n\n` +
    `Stubs (upgrade if topic matches):\n${stubList}${upgradeHint}\n\n` +
    `Generate a full entry for: "${topic}"`,
    { thinking: true, maxTokens: 6000 }
  );
  const content = parseJSON(p1Raw);
  delete content.stub;

  if (verbose) { console.log('\n── P1 ──'); console.log(JSON.stringify(content, null, 2)); }

  const allPlainText = [
    content.inline,
    content.sections?.why,
    content.sections?.def,
    content.sections?.prop,
    ...(content.sections?.proof ?? []),
  ].filter(Boolean).join('\n\n');

  // ── Phase 2: Ref detection ──────────────────────────────────────────────
  console.log(`[P2] Detecting references...`);

  const p2Raw = await callClaude(SYS_P2,
    `Known concept pool:\n${allList}\n\nText for concept "${content.title}" (id: ${content.id}):\n${allPlainText}`,
    { maxTokens: 3000 }
  );
  const { refs: refList } = parseJSON(p2Raw);

  if (verbose) { console.log('\n── P2 ──'); console.log(JSON.stringify(refList, null, 2)); }

  // ── Phase 3: Dependency classification ─────────────────────────────────
  console.log(`[P3] Classifying dependencies...`);

  const graphSummary = fullConcepts.map(c => {
    const req = (c.refs ?? []).filter(r => r.type === 'required').map(r => r.id);
    return req.length ? `  ${c.id} requires: ${req.join(', ')}` : null;
  }).filter(Boolean).join('\n') || '  (none)';

  // Phase 3 gets canonical IDs (ref.id) — alias_id is an HTML-layer concern only
  const refSummary = refList.map(r => `  ${r.id}: "${r.word}"`).join('\n') || '  (none)';
  const coreText = [content.inline, content.sections?.def].filter(Boolean).join('\n\n');

  const p3Raw = await callClaude(SYS_P3,
    `Core text (inline + definition):\n${coreText}\n\n` +
    `Full text (all sections):\n${allPlainText}\n\n` +
    `Detected refs (canonical IDs):\n${refSummary}\n\n` +
    `Existing required-dependency graph:\n${graphSummary}`,
    { maxTokens: 2000 }
  );
  const { refs: classifiedRefs } = parseJSON(p3Raw);

  if (verbose) { console.log('\n── P3 ──'); console.log(JSON.stringify({ refs: classifiedRefs }, null, 2)); }

  // ── Deterministic stub collection (between P3 and P4) ──────────────────
  // Every ID Phase 3 classified must end up in the file — regardless of
  // whether Phase 2 marked it as new:true. We build the list now so Phase 5
  // can validate against the full expected set.
  const existingIds = new Set(data.concepts.map(c => c.id));
  existingIds.add(content.id);

  const pendingStubs = [];   // { id, word, inline } — to create in write step
  for (const r of (classifiedRefs ?? [])) {
    if (!existingIds.has(r.id) && !pendingStubs.find(s => s.id === r.id)) {
      const p2ref = refList.find(x => x.id === r.id);
      const inline = p2ref?.inline ?? null;
      pendingStubs.push({ id: r.id, word: p2ref?.word, inline });
      existingIds.add(r.id);
      if (!inline && verbose)
        console.log(`  ⚠ No Phase-2 inline for "${r.id}" — placeholder will be used`);
    }
  }

  // ── Phase 4: HTML assembly (deterministic) ──────────────────────────────
  console.log(`[P4] Assembling HTML...`);

  const concept = {
    id:       content.id,
    title:    content.title,
    subtitle: content.subtitle,
    inline:   wrapRefs(content.inline, refList),
    refs:     classifiedRefs ?? [],
    page: {
      blocks:  assembleBlocks(content.sections, refList),
      related: [],
    },
  };

  if (verbose) { console.log('\n── P4 ──'); console.log(JSON.stringify(concept, null, 2)); }

  // ── Phase 5: Validation ─────────────────────────────────────────────────
  console.log(`[P5] Validating...`);

  // Build mock data that includes all entries we'll create in the write step
  const mockExtras = [];
  for (const ref of refList)
    if (ref.alias_id && !data.concepts.find(c => c.id === ref.alias_id))
      mockExtras.push(makeAlias(ref.alias_id, ref.id, ref.alias_inline));
  for (const { id, word, inline } of pendingStubs)
    if (!data.concepts.find(c => c.id === id))
      mockExtras.push(makeStub(id, word, inline));
  const mockConcepts = [...data.concepts, ...mockExtras];

  const issues = validate(concept, { concepts: mockConcepts });

  if (issues.length) {
    console.log('\n  Validation issues:');
    issues.forEach(i => console.log(`    ✗ ${i}`));
    console.log('  Proceeding with warnings — review output manually.\n');
  } else {
    console.log('  ✓ All checks passed.\n');
  }

  if (dryRun) {
    console.log('[dry-run] Not writing to concepts.json.');
    return;
  }

  // ── Write ────────────────────────────────────────────────────────────────
  let added = 0, upgraded = 0, skipped = 0, aliased = 0, autoStubbed = 0;

  // Main concept
  const idx = data.concepts.findIndex(c => c.id === concept.id);
  if (idx >= 0) {
    if (isStubLike(data.concepts[idx]) && !isAlias(data.concepts[idx])) {
      data.concepts[idx] = concept;
      upgraded++;
      console.log(`  ↑ Upgraded  "${concept.title}" (${concept.id})`);
    } else {
      skipped++;
      console.log(`  ~ Skipped   "${concept.title}" (${concept.id}) — already full`);
    }
  } else {
    data.concepts.push(concept);
    added++;
    console.log(`  + Added     "${concept.title}" (${concept.id})`);
  }

  const knownIds = new Set(data.concepts.map(c => c.id));

  // Alias entries from Phase 2
  for (const ref of refList) {
    if (ref.alias_id && !knownIds.has(ref.alias_id)) {
      data.concepts.push(makeAlias(ref.alias_id, ref.id, ref.alias_inline));
      knownIds.add(ref.alias_id);
      aliased++;
      console.log(`  ↳ Alias     "${ref.alias_id}" → "${ref.id}"`);
    }
  }

  // Deterministic stubs for all Phase 3 classified IDs (not AI-flag-dependent)
  for (const { id, word, inline } of pendingStubs) {
    if (!knownIds.has(id)) {
      data.concepts.push(makeStub(id, word, inline));
      knownIds.add(id);
      autoStubbed++;
      console.log(`  ~ Stub      "${id}"${inline ? `: ${inline.slice(0, 60)}…` : ' [no inline from Phase 2]'}`);
    }
  }

  // Catch-all: stub any data-ref IDs the HTML contains that are still unknown
  for (const html of allHtmlStrings(concept)) {
    for (const refId of extractDataRefs(html)) {
      if (!knownIds.has(refId)) {
        data.concepts.push(makeStub(refId));
        knownIds.add(refId);
        autoStubbed++;
        console.log(`  ~ Auto-stub "${refId}" (from HTML catch-all)`);
      }
    }
  }

  await writeFile(CONCEPTS_PATH, JSON.stringify(data, null, 2), 'utf8');

  // ── Correction pass ──────────────────────────────────────────────────────
  console.log(`\n[Correction] Verifying written concept...`);
  const corrections = [];
  let correctionWrites = 0;

  // Every refs[] ID must have a concept entry
  for (const r of concept.refs ?? []) {
    if (!knownIds.has(r.id)) {
      data.concepts.push(makeStub(r.id));
      knownIds.add(r.id);
      corrections.push(`Created missing stub for refs[] ID "${r.id}"`);
      correctionWrites++;
    }
  }

  // Every data-ref ID in HTML must have a concept entry
  for (const html of allHtmlStrings(concept)) {
    for (const refId of extractDataRefs(html)) {
      if (!knownIds.has(refId)) {
        data.concepts.push(makeStub(refId));
        knownIds.add(refId);
        corrections.push(`Created missing stub for data-ref "${refId}"`);
        correctionWrites++;
      }
    }
  }

  // Warn about refs[] IDs that have no span in the HTML (wrapRefs may have missed them)
  const spanIds = new Set(allHtmlStrings(concept).flatMap(extractDataRefs));
  for (const r of concept.refs ?? []) {
    const coveredByAlias = data.concepts.some(c => isAlias(c) && c.alias_of === r.id && spanIds.has(c.id));
    if (!spanIds.has(r.id) && !coveredByAlias)
      corrections.push(`⚠ refs[] ID "${r.id}" has no data-ref span in HTML — term may not appear in text or wrapRefs failed`);
  }

  if (corrections.length) {
    console.log('');
    corrections.forEach(c => console.log(`  ${c.startsWith('⚠') ? '' : '✓ '}${c}`));
    if (correctionWrites > 0) {
      await writeFile(CONCEPTS_PATH, JSON.stringify(data, null, 2), 'utf8');
      console.log(`  File updated with ${correctionWrites} correction(s).\n`);
    }
  } else {
    console.log('  ✓ All references verified.\n');
  }

  console.log(`Done. Added ${added}, upgraded ${upgraded}, skipped ${skipped}, aliases ${aliased}, stubs ${autoStubbed + correctionWrites}.`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const flags   = new Set(args.filter(a => a.startsWith('--')));
const topic   = args.find(a => !a.startsWith('--'));
const dryRun  = flags.has('--dry-run');
const verbose = flags.has('--verbose');

if (!topic) {
  console.error('Usage: node generate.js [--dry-run] [--verbose] "<concept name>"');
  process.exit(1);
}

generateConcept(topic, { dryRun, verbose }).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCEPTS_PATH = join(__dirname, 'concepts.json');
const client = new Anthropic();

// ── System prompts ────────────────────────────────────────────────────────

const SYS_P1 = `You generate rigorous mathematical content for a commutative algebra learning app.

Output a single JSON object — NO HTML, NO <span> tags, NO data-ref attributes. Plain text with LaTeX math only, plus {ref:id} notation markers (see below).

Schema:
{
  "id": "kebab-case-id",
  "title": "English title",
  "inline": "1–3 sentence English summary. Plain text with LaTeX. No HTML.",
  "sections": {
    "why": "Motivation paragraph in English. What problem does this concept solve?",
    "def": "Primary formal definition in English — ONE definition only, no equivalent formulations here.",
    "def_proof": "(optional) Complete proof as continuous mathematical prose with LaTeX.",
    "equiv": ["First equivalent characterization in English with LaTeX", "Second equivalent characterization", "..."],
    "equiv_proof": "(optional) Complete proof that these characterizations are equivalent, as continuous mathematical prose with LaTeX.",
    "prop": "Main proposition or theorem (omit key if none).",
    "prop_proof": "(optional) Complete proof of the proposition, as continuous mathematical prose with LaTeX.",
    "cases": ["Case (a) in English with LaTeX", "Case (b)", "..."]
  }
}

Rules:
- Write in English. Formal mathematical language.
- LaTeX: inline \\( ... \\), display \\[ ... \\]. All backslashes doubled in JSON strings.
- Use \\mathfrak{a}, \\mathfrak{b} for ideals; \\mathfrak{m} for maximal ideals.
- Do NOT write any HTML tags. Do NOT add data-ref attributes.
- ENUMERATED CONDITIONS: separate each axiom or condition with \\n — e.g. "(i) first condition\\n(ii) second condition\\n(iii) third condition". Never run conditions together as one sentence.
- EMPHASIS: use \\emph{text} for emphasis in running prose (outside math delimiters). Do NOT use \\emph inside \\( ... \\) or \\[ ... \\].
- NOTATION REFS: if a LaTeX expression directly represents a named concept in the known pool, append {ref:concept-id} immediately after its closing delimiter with no space — e.g. \\(\\mathrm{Spec}(R)\\){ref:spectrum-of-a-ring} or \\(\\ker(\\varphi)\\){ref:ideal}. Only use IDs that exist in the provided concept pool.
- def: PRIMARY definition only. Any statement of the form "equivalent to ...", "this is equivalent to ...", or "if and only if ..." belongs in equiv, not def.
- equiv: array of equivalent characterizations, one complete English sentence per item. Omit key entirely if none.
- def_proof / equiv_proof / prop_proof: write as a complete, rigorous, standalone proof in the style of a graduate algebra textbook — continuous mathematical prose with LaTeX. Use \\[ ... \\] for key equations. No step numbers, no bullet points, no section headers. Include every logical step needed for the proof to be self-contained. Omit if there is nothing non-trivial to prove.
- cases: array of PARALLEL worked examples or remarks (e.g. "In \\(\\mathbb{Z}\\), ...", "If \\(R\\) is a field, ...") — rendered as a dashed list labelled "Examples". Do NOT use for proofs; proofs belong in the *_proof fields.
- Omit "equiv", "prop", "cases", "def_proof", "equiv_proof", "prop_proof" keys entirely if not applicable.
- Output only JSON, no markdown fences.`;

const SYS_P2 = `You identify mathematical concept references in English mathematical text.

Given: plain text + a pool of known concept IDs with titles. Concepts marked [stub] are placeholders without full content yet.

Output a single JSON object:
{
  "refs": [
    { "word": "ring", "id": "ring", "new": false },
    { "word": "subgroup", "id": "subgroup", "new": false,
      "inline": "A subgroup is a subset of a group that is itself a group under the group operation." },
    { "word": "quotient ring", "id": "quotient-ring", "new": false,
      "alias_id": "quotient-ring-alt",
      "alias_inline": "A quotient ring is a ring of the form \\\\(R/\\\\mathfrak{a}\\\\)." },
    { "word": "new structure", "id": "new-structure", "new": true,
      "inline": "A new structure is a set with..." }
  ]
}

Field meanings:
- word: the EXACT string as it appears in the text, including plural or other inflected forms (e.g. "ring homomorphisms" not "ring homomorphism", "ideals" not "ideal"). Never use base/uninflected forms.
- id: canonical concept ID — use the existing pool ID if the concept exists, otherwise propose a new kebab-case ID
- new: true ONLY when the concept genuinely does not exist anywhere in the pool
- inline: (required when new:true OR when concept is marked [stub] in the pool) — one-sentence English definition for this concept, with LaTeX if needed
- alias_id: (optional) if the word is a synonym or alternative name for an existing concept, provide a new kebab-case alias ID for this word form; keep "id" as the canonical ID
- alias_inline: (required when alias_id is set) one-sentence English definition for this word form, with LaTeX if needed

Classification rules:
- Only identify terms that name mathematical concepts (definitions, structures, theorems) — not generic words like "set", "function", or "element" unless they name a specific structure.
- Match to existing pool IDs whenever the concept is the same, even if the phrasing differs (use alias_id for the variant word form).
- MULTIPLE FORMS: if the same concept appears under multiple distinct forms (e.g. both "ring homomorphism" and "ring homomorphisms"), add a SEPARATE ref entry for each distinct form, all pointing to the same canonical id.
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
- "required": the concept is semantically necessary for a reader to understand the formal definition (the def field). Apply "required" when:
    (a) IS-A / parent type: the definition says "X is a Y", "X is an additive Y", "X is the Y of ...", or similar — Y is the mathematical structure that X is a subtype or instance of.
    (b) Core ingredient: the definition directly invokes this concept's defining operation, axioms, or structure by name, and the definition cannot be understood without it.
    Do NOT mark as required: concepts that appear in def for contrast, analogy, or context; concepts mentioned only in proofs, equivalent characterizations, motivation, or examples.
- "enriches": everything else — concepts in proofs, motivation, examples, or equivalences; concepts in def that provide context rather than being what the concept IS or a core ingredient.
- The inline summary often re-states what the def already says; do not count a concept as "required" just because it appears in both inline and def.
- Default to "enriches" for any concept that does not clearly satisfy (a) or (b) in the def field.
- CYCLE RULE: if concept B already requires concept A (directly or transitively), do NOT classify A as "required" here — use "enriches" instead to avoid mutual required dependencies.
- Max 10 required refs. Demote the least essential ones to "enriches" if over limit.
- Each ID appears at most once in refs[].
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

// Convert {ref:id} notation markers (produced by P1) into clickable spans.
// Must run after wrapRefs so the LaTeX portion is still intact in the text.
function resolveNotationRefs(text) {
  if (!text) return text;
  return text
    .replace(/(\\\((?:[^\\]|\\[^)])*\\\))\{ref:([\w-]+)\}/g,
      (_, latex, id) => `<span class="t" data-ref="${id}">${latex}</span>`)
    .replace(/(\\\[(?:[^\\]|\\[^\]])*\\\])\{ref:([\w-]+)\}/g,
      (_, latex, id) => `<span class="t" data-ref="${id}">${latex}</span>`)
    .replace(/\{ref:[\w-]+\}/g, '');
}

function plainToHtml(text) {
  if (!text) return '';
  return text
    .replace(/\\emph\{([^}]*)\}/g, '<em>$1</em>')
    .replace(/\\textbf\{([^}]*)\}/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
    .trim();
}

function assembleBlocks(sections, refList) {
  const blocks = [];
  const wrap = s => resolveNotationRefs(wrapRefs(plainToHtml(s), refList));
  if (sections?.why) blocks.push({
    type: 'why', label: 'Motivation',
    body: wrap(sections.why),
  });
  if (sections?.def) {
    const b = { type: 'def', label: 'Definition', body: wrap(sections.def) };
    if (sections.def_proof) b.proof = wrap(sections.def_proof);
    blocks.push(b);
  }
  if (sections?.equiv?.length) {
    const b = { type: 'equiv', label: 'Equivalent Characterizations', items: sections.equiv.map(wrap) };
    if (sections.equiv_proof) b.proof = wrap(sections.equiv_proof);
    blocks.push(b);
  }
  if (sections?.prop) {
    const b = { type: 'prop', label: 'Proposition', body: wrap(sections.prop) };
    if (sections.prop_proof) b.proof = wrap(sections.prop_proof);
    blocks.push(b);
  }
  if (sections?.cases?.length) blocks.push({
    type: 'cases', label: 'Examples',
    items: sections.cases.map(wrap),
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
    if (b.body)   out.push(b.body);
    if (b.proof)  out.push(b.proof);
    for (const s    of b.steps ?? []) out.push(s);
    for (const item of b.items ?? []) out.push(item);
  }
  return out.filter(Boolean);
}

// ── Stub / alias factories ────────────────────────────────────────────────

function makeStub(id, title, inline) {
  if (!inline) throw new Error(`makeStub called without inline for "${id}" — this is a bug in the pipeline`);
  return {
    stub: true, id,
    title: title || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    inline,
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

// ── Strip {ref:id} markers from a content string ──────────────────────────

function stripNotationMarkers(text, idSet) {
  if (!text) return text;
  return text.replace(/\{ref:([\w-]+)\}/g, (match, id) => idSet.has(id) ? match : '');
}

// ── Main pipeline ─────────────────────────────────────────────────────────

async function generateConcept(topic, { dryRun = false, verbose = false } = {}) {
  const data = JSON.parse(await readFile(CONCEPTS_PATH, 'utf8'));

  const existingIds = new Set(data.concepts.map(c => c.id));
  const fullConcepts = data.concepts.filter(c => !isStubLike(c) && !isAlias(c));
  const stubConcepts = data.concepts.filter(c => isStubLike(c) && !isAlias(c));
  const fullList = fullConcepts.map(c => `  ${c.id}: ${c.title}`).join('\n') || '  (none)';
  const stubList = stubConcepts.map(c => `  ${c.id}: ${c.title}`).join('\n') || '  (none)';

  // Pool for Phase 2: stubs are marked so Claude knows to provide inline text for them
  const allList = data.concepts.map(c => c.alias_of
    ? `  ${c.id} [alias→${c.alias_of}]: ${c.title || c.id}`
    : isStubLike(c)
      ? `  ${c.id} [stub]: ${c.title}`
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
  existingIds.add(content.id);

  if (verbose) { console.log('\n── P1 ──'); console.log(JSON.stringify(content, null, 2)); }

  // Extract {ref:id} notation markers from raw P1 output
  const rawPlainText = [
    content.inline,
    content.sections?.why,
    content.sections?.def,
    ...(content.sections?.equiv ?? []),
    content.sections?.prop,
    ...(content.sections?.cases ?? []),
    ...(content.sections?.proof ?? []),
  ].filter(Boolean).join('\n\n');

  const notationRefIds = new Set();
  const notMarkerRe = /\{ref:([\w-]+)\}/g;
  let notMarkerMatch;
  while ((notMarkerMatch = notMarkerRe.exec(rawPlainText)) !== null) {
    notationRefIds.add(notMarkerMatch[1]);
  }

  // Validate notation markers: strip any that reference IDs not in the existing pool.
  // Phase 1 is instructed to only use known IDs; violations are model errors, not stubs.
  const invalidNotationIds = [...notationRefIds].filter(id => !existingIds.has(id));
  if (invalidNotationIds.length) {
    console.log(`  ⚠ P1 used unknown notation ref IDs (stripped): ${invalidNotationIds.join(', ')}`);
    const escapedIds = invalidNotationIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const stripRe = new RegExp(`\\{ref:(${escapedIds.join('|')})\\}`, 'g');
    content.inline = content.inline?.replace(stripRe, '') ?? content.inline;
    if (content.sections) {
      for (const key of ['why', 'def', 'prop']) {
        if (content.sections[key]) content.sections[key] = content.sections[key].replace(stripRe, '');
      }
      for (const key of ['equiv', 'cases', 'proof']) {
        if (Array.isArray(content.sections[key]))
          content.sections[key] = content.sections[key].map(s => s.replace(stripRe, ''));
      }
    }
    for (const id of invalidNotationIds) notationRefIds.delete(id);
  }

  // Build stripped plain text for Phase 2 / Phase 3 (remove valid {ref:id} markers too)
  const allPlainTextStripped = [
    content.inline,
    content.sections?.why,
    content.sections?.def,
    ...(content.sections?.equiv ?? []),
    content.sections?.prop,
    ...(content.sections?.cases ?? []),
    ...(content.sections?.proof ?? []),
  ].filter(Boolean).join('\n\n').replace(/\{ref:[\w-]+\}/g, '');

  // ── Phase 2: Ref detection ──────────────────────────────────────────────
  console.log(`[P2] Detecting references...`);

  const p2Raw = await callClaude(SYS_P2,
    `Known concept pool:\n${allList}\n\nText for concept "${content.title}" (id: ${content.id}):\n${allPlainTextStripped}`,
    { maxTokens: 3000 }
  );
  const { refs: refList } = parseJSON(p2Raw);

  if (verbose) { console.log('\n── P2 ──'); console.log(JSON.stringify(refList, null, 2)); }

  // Build inline lookup from Phase 2 — used for stub creation after Phase 4.
  // Only canonical (non-alias) refs with inline text can produce stubs.
  const p2InlineMap = new Map();
  for (const ref of refList) {
    if (ref.inline) p2InlineMap.set(ref.id, { word: ref.word, inline: ref.inline });
  }

  // ── Phase 3: Dependency classification ─────────────────────────────────
  console.log(`[P3] Classifying dependencies...`);

  const graphSummary = fullConcepts.map(c => {
    const req = (c.refs ?? []).filter(r => r.type === 'required').map(r => r.id);
    return req.length ? `  ${c.id} requires: ${req.join(', ')}` : null;
  }).filter(Boolean).join('\n') || '  (none)';

  // Phase 3 gets canonical IDs (ref.id) — alias_id is an HTML-layer concern only
  const refSummary = refList.map(r => `  ${r.id}: "${r.word}"`).join('\n') || '  (none)';
  const coreTextStripped = [content.inline, content.sections?.def]
    .filter(Boolean).join('\n\n').replace(/\{ref:[\w-]+\}/g, '');

  const p3Raw = await callClaude(SYS_P3,
    `Core text (inline + definition):\n${coreTextStripped}\n\n` +
    `Full text (all sections):\n${allPlainTextStripped}\n\n` +
    `Detected refs (canonical IDs):\n${refSummary}\n\n` +
    `Existing required-dependency graph:\n${graphSummary}`,
    { maxTokens: 2000 }
  );
  const { refs: classifiedRefs } = parseJSON(p3Raw);

  if (verbose) { console.log('\n── P3 ──'); console.log(JSON.stringify({ refs: classifiedRefs }, null, 2)); }

  // ── IS-A safety net: promote enriches→required for parent-type refs in def ─
  if (content.sections?.def && classifiedRefs?.length) {
    const defNonLatex = tokenizeLatex(content.sections.def)
      .filter(s => !s.latex).map(s => s.text).join('');

    const reqGraph = buildRequiredGraph(data.concepts);
    const tentativeRequired = new Set(
      classifiedRefs.filter(r => r.type === 'required').map(r => r.id)
    );
    reqGraph.set(content.id, tentativeRequired);

    for (const r of classifiedRefs) {
      if (r.type !== 'enriches') continue;
      const refEntry = refList.find(x => x.id === r.id);
      if (!refEntry) continue;

      // Strip trailing 's' so singular/plural both match against the def
      const stem = refEntry.word.replace(/s$/i, '');
      const esc  = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // IS-A: (is|are|be) + up to 4 intermediate words + stem (optional trailing s)
      const isAPattern = new RegExp(
        `(?:is|are|be)\\s+(?:\\S+\\s+){0,4}${WB_L}${esc}s?${WB_R}`, 'i'
      );
      if (!isAPattern.test(defNonLatex)) continue;

      if (canReach(reqGraph, r.id, content.id)) {
        console.log(`  ~ IS-A match for "${r.id}" skipped — would create cycle`);
        continue;
      }
      if (tentativeRequired.size >= 10) {
        console.log(`  ~ IS-A match for "${r.id}" skipped — 10 required limit reached`);
        continue;
      }

      r.type = 'required';
      tentativeRequired.add(r.id);
      reqGraph.set(content.id, tentativeRequired);
      console.log(`  ↑ IS-A: promoted "${r.id}" to required`);
    }
  }

  // ── Phase 4: HTML assembly (deterministic) ──────────────────────────────
  console.log(`[P4] Assembling HTML...`);

  const concept = {
    id:        content.id,
    title:     content.title,
    generated: new Date().toISOString().slice(0, 10),
    inline:    resolveNotationRefs(wrapRefs(content.inline, refList)),
    refs:      classifiedRefs ?? [],
    page: {
      blocks:  assembleBlocks(content.sections, refList),
      related: [],
    },
  };

  if (verbose) { console.log('\n── P4 ──'); console.log(JSON.stringify(concept, null, 2)); }

  // ── Phase 5: Validation ─────────────────────────────────────────────────
  console.log(`[P5] Validating...`);

  // Build mock data: existing concepts + aliases + stubs that will be created from data-ref scan
  const mockExtras = [];
  const mockIds = new Set([...existingIds]);

  for (const ref of refList)
    if (ref.alias_id && !mockIds.has(ref.alias_id)) {
      mockExtras.push(makeAlias(ref.alias_id, ref.id, ref.alias_inline));
      mockIds.add(ref.alias_id);
    }

  for (const html of allHtmlStrings(concept)) {
    for (const refId of extractDataRefs(html)) {
      if (!mockIds.has(refId)) {
        const info = p2InlineMap.get(refId);
        if (info) {
          mockExtras.push(makeStub(refId, info.word, info.inline));
          mockIds.add(refId);
        }
      }
    }
  }

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

  // Stubs: only created for data-ref IDs in the assembled HTML that are not yet in the file.
  // Inline text comes exclusively from Phase 2 — no placeholders.
  for (const html of allHtmlStrings(concept)) {
    for (const refId of extractDataRefs(html)) {
      if (!knownIds.has(refId)) {
        const info = p2InlineMap.get(refId);
        if (!info) {
          console.log(`  ✗ No inline for data-ref "${refId}" — stub not created (Phase 2 missed this term)`);
          continue;
        }
        data.concepts.push(makeStub(refId, info.word, info.inline));
        knownIds.add(refId);
        autoStubbed++;
        console.log(`  ~ Stub      "${refId}": ${info.inline.slice(0, 60)}…`);
      }
    }
  }

  await writeFile(CONCEPTS_PATH, JSON.stringify(data, null, 2), 'utf8');

  // ── Correction pass (warnings only — no stub creation) ───────────────────
  console.log(`\n[Correction] Verifying written concept...`);
  const corrections = [];

  for (const r of concept.refs ?? [])
    if (!knownIds.has(r.id))
      corrections.push(`⚠ refs[] ID "${r.id}" has no entry in file — Phase 3 classified an unrecognized ID`);

  for (const html of allHtmlStrings(concept))
    for (const refId of extractDataRefs(html))
      if (!knownIds.has(refId))
        corrections.push(`⚠ data-ref "${refId}" has no entry — no Phase-2 inline was available`);

  const spanIds = new Set(allHtmlStrings(concept).flatMap(extractDataRefs));
  for (const r of concept.refs ?? []) {
    const coveredByAlias = data.concepts.some(c => isAlias(c) && c.alias_of === r.id && spanIds.has(c.id));
    if (!spanIds.has(r.id) && !coveredByAlias)
      corrections.push(`⚠ refs[] ID "${r.id}" has no data-ref span in HTML — term may not appear in text or wrapRefs failed`);
  }

  if (corrections.length) {
    console.log('');
    corrections.forEach(c => console.log(`  ${c}`));
    console.log('');
  } else {
    console.log('  ✓ All references verified.\n');
  }

  console.log(`Done. Added ${added}, upgraded ${upgraded}, skipped ${skipped}, aliases ${aliased}, stubs ${autoStubbed}.`);
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

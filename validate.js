import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await readFile(join(__dirname, 'concepts.json'), 'utf8'));

const allIds = new Set(data.concepts.map(c => c.id));

function extractRefs(html) {
  const refs = [];
  const re = /data-ref="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) refs.push(m[1]);
  return refs;
}

function htmlStrings(concept) {
  const out = [];
  if (concept.inline) out.push(concept.inline);
  for (const block of concept.page?.blocks ?? []) {
    if (block.body) out.push(block.body);
    for (const step of block.steps ?? []) out.push(step);
    for (const item of block.items ?? []) out.push(item);
  }
  return out;
}

const broken = [];   // { from, ref, location }
const related = [];  // { from, ref } — related IDs that resolve nowhere

for (const concept of data.concepts) {
  for (const html of htmlStrings(concept)) {
    for (const ref of extractRefs(html)) {
      if (!allIds.has(ref)) broken.push({ from: concept.id, ref });
    }
  }
  for (const entry of concept.page?.related ?? []) {
    const ref = typeof entry === 'string' ? entry : entry.id;
    if (!allIds.has(ref)) related.push({ from: concept.id, ref });
  }
  for (const entry of concept.refs ?? []) {
    if (!allIds.has(entry.id)) related.push({ from: concept.id, ref: entry.id });
  }
}

if (broken.length === 0 && related.length === 0) {
  console.log(`✓ All references resolve. (${data.concepts.length} concepts checked)`);
  process.exit(0);
}

if (broken.length > 0) {
  console.log(`\nBroken inline $refs (data-ref points to missing concept):`);
  for (const { from, ref } of broken) {
    console.log(`  ${from}  →  missing: ${ref}`);
  }
}

if (related.length > 0) {
  console.log(`\nUnresolved related[] IDs (will render as placeholder pills):`);
  for (const { from, ref } of related) {
    console.log(`  ${from}  →  missing: ${ref}`);
  }
}

console.log(`\n${broken.length} broken inline ref(s), ${related.length} unresolved related ID(s).`);
process.exit(broken.length > 0 ? 1 : 0);

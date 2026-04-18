const fs = require('fs');
const path = require('path');

const FULL_DIR = path.join(process.cwd(), 'laws', 'full');
const LAWS_DIR = path.join(process.cwd(), 'laws');
const CHUNKS_DIR = path.join(LAWS_DIR, 'chunks');
const MIN_LEN = 200;
const TARGET = 500;
const MAX = 650;
const SKIP = new Set(['index.json', 'errors.json', 'stats.json', 'cleanup_report.json']);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function splitText(text, target = TARGET, max = MAX) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  if (!clean) return [];

  const pieces = clean
    .split(/(?<=[\n\.!؟]|،)/u)
    .map(s => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const piece of pieces) {
    if (!current) {
      current = piece;
      continue;
    }

    const candidate = current + ' ' + piece;
    if (candidate.length <= target) {
      current = candidate;
      continue;
    }

    if (current.length >= MIN_LEN || candidate.length > max) {
      chunks.push(current.trim());
      current = piece;
    } else {
      current = candidate;
      if (current.length > max) {
        chunks.push(current.trim());
        current = '';
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());

  const normalized = [];
  for (const ch of chunks) {
    if (ch.length <= max) normalized.push(ch);
    else {
      let start = 0;
      while (start < ch.length) {
        let end = Math.min(start + target, ch.length);
        const window = ch.slice(start, Math.min(start + max, ch.length));
        const breakMatch = [...window.matchAll(/[\n\.!؟،]/gu)].pop();
        if (breakMatch && start + breakMatch.index + 1 > start + Math.floor(target * 0.6)) {
          end = start + breakMatch.index + 1;
        } else {
          end = Math.min(start + max, ch.length);
        }
        normalized.push(ch.slice(start, end).trim());
        start = end;
      }
    }
  }

  return normalized.filter(Boolean);
}

function main() {
  ensureDir(LAWS_DIR);
  ensureDir(CHUNKS_DIR);

  const files = fs.readdirSync(FULL_DIR).filter(f => f.endsWith('.json') && !SKIP.has(f));
  const included = [];
  const excluded = [];
  const chunks = [];

  for (const file of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(FULL_DIR, file), 'utf8'));
    const len = String(obj.content || '').length;
    if (len >= MIN_LEN) included.push(obj.id);
    else excluded.push(obj.id);
  }

  fs.writeFileSync(path.join(LAWS_DIR, 'chunking_set.json'), JSON.stringify(included, null, 2), 'utf8');
  fs.writeFileSync(path.join(LAWS_DIR, 'excluded_stubs.json'), JSON.stringify(excluded, null, 2), 'utf8');

  for (const file of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(FULL_DIR, file), 'utf8'));
    if (String(obj.content || '').length < MIN_LEN) continue;

    const lawChunks = splitText(obj.content);
    const total = lawChunks.length;

    lawChunks.forEach((text, idx) => {
      chunks.push({
        law_id: obj.id,
        title: obj.title,
        category: obj.category,
        year: obj.year,
        url: obj.url,
        chunk_index: idx,
        total_chunks: total,
        text,
      });
    });
  }

  fs.writeFileSync(path.join(CHUNKS_DIR, 'all_chunks.json'), JSON.stringify(chunks, null, 2), 'utf8');

  const report = {
    totalIncluded: included.length,
    totalExcluded: excluded.length,
    totalChunks: chunks.length,
    averageChunksPerLaw: included.length ? Number((chunks.length / included.length).toFixed(2)) : 0,
  };
  fs.writeFileSync(path.join(CHUNKS_DIR, 'chunk_report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main();

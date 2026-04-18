const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SOURCE = path.join(process.cwd(), 'laws', 'chunks', 'chunks_ready.jsonl');
const PROGRESS = path.join(process.cwd(), 'laws', 'chunks', 'upload_progress.json');
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 1000;
const LOG_EVERY = 500;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !VOYAGE_API_KEY) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

async function* readChunks() {
  const stream = fs.createReadStream(SOURCE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

async function existingChunkIds(ids) {
  if (!ids.length) return new Set();
  const encoded = ids.map(encodeURIComponent).join(',');
  const url = `${SUPABASE_URL}/rest/v1/law_chunks?select=chunk_id&chunk_id=in.(${encoded})`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase existing check failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return new Set(data.map(r => r.chunk_id));
}

async function embedTexts(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'voyage-law-2',
      input_type: 'document',
      input: texts,
    }),
  });
  if (!res.ok) throw new Error(`Voyage failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map(x => x.embedding);
}

async function insertRows(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/law_chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status} ${await res.text()}`);
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 2), 'utf8');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function processBatch(batch, stats) {
  const existing = await existingChunkIds(batch.map(x => x.chunk_id));
  stats.skippedExisting += existing.size;
  const pending = batch.filter(x => !existing.has(x.chunk_id));

  if (pending.length) {
    const embeddings = await embedTexts(pending.map(x => x.text));
    const rows = pending.map((chunk, idx) => ({
      chunk_id: chunk.chunk_id,
      law_id: chunk.law_id,
      title: chunk.title,
      category: chunk.category,
      year: chunk.year,
      url: chunk.url,
      chunk_index: chunk.chunk_index,
      total_chunks: chunk.total_chunks,
      text: chunk.text,
      embedding: embeddings[idx],
    }));
    await insertRows(rows);
    stats.uploaded += pending.length;
  }

  stats.processed += batch.length;
  stats.lastChunkId = batch[batch.length - 1].chunk_id;
  stats.updatedAt = new Date().toISOString();
  saveProgress(stats);

  if (stats.processed % LOG_EVERY === 0 || stats.processed < LOG_EVERY && stats.processed === batch.length) {
    console.log(`[PROGRESS] processed=${stats.processed} uploaded=${stats.uploaded} skippedExisting=${stats.skippedExisting} last=${stats.lastChunkId}`);
  }

  await sleep(BATCH_DELAY_MS);
}

async function main() {
  const stats = {
    mode: 'full',
    batchSize: BATCH_SIZE,
    delayMs: BATCH_DELAY_MS,
    processed: 0,
    uploaded: 0,
    skippedExisting: 0,
    lastChunkId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveProgress(stats);

  let batch = [];
  for await (const chunk of readChunks()) {
    batch.push(chunk);
    if (batch.length >= BATCH_SIZE) {
      await processBatch(batch, stats);
      batch = [];
    }
  }
  if (batch.length) await processBatch(batch, stats);

  stats.finishedAt = new Date().toISOString();
  saveProgress(stats);
  console.log(JSON.stringify({
    done: true,
    processed: stats.processed,
    uploaded: stats.uploaded,
    skippedExisting: stats.skippedExisting,
    lastChunkId: stats.lastChunkId,
    progressFile: PROGRESS,
  }, null, 2));
}

main().catch(err => {
  try {
    saveProgress({
      mode: 'full',
      error: err.message,
      stack: err.stack,
      updatedAt: new Date().toISOString(),
    });
  } catch {}
  console.error(err);
  process.exit(1);
});

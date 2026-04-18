const fs = require('fs');
const path = require('path');

const IN_FILE = path.join(process.cwd(), 'laws', 'chunks', 'all_chunks.json');
const OUT_FILE = path.join(process.cwd(), 'laws', 'chunks', 'chunks_ready.jsonl');

function main() {
  const chunks = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const out = fs.createWriteStream(OUT_FILE, { encoding: 'utf8' });

  for (const ch of chunks) {
    const chunkNumber = Number(ch.chunk_index) + 1;
    const chunk_id = `${ch.law_id}_${String(chunkNumber).padStart(4, '0')}`;
    const record = {
      chunk_id,
      law_id: ch.law_id,
      title: ch.title,
      category: ch.category,
      year: ch.year,
      url: ch.url,
      chunk_index: chunkNumber,
      total_chunks: ch.total_chunks,
      text: ch.text,
    };
    out.write(JSON.stringify(record) + '\n');
  }

  out.end();
  out.on('finish', () => {
    const stats = fs.statSync(OUT_FILE);
    console.log(JSON.stringify({
      totalLines: chunks.length,
      fileSizeBytes: stats.size,
      fileSizeMB: Number((stats.size / (1024 * 1024)).toFixed(2))
    }, null, 2));
  });
}

main();

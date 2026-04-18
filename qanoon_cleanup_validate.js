const fs = require('fs');
const path = require('path');

const DIR = path.join(process.cwd(), 'laws', 'full');
const SKIP = new Set(['index.json', 'errors.json', 'stats.json']);

function cleanContent(content) {
  let t = String(content || '').replace(/\r/g, '').trim();
  t = t.replace(/^(?:تحميل\s*English|English\s*تحميل|تحميل|English)\s*/u, '').trim();
  return t;
}

function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !SKIP.has(f));
  let good = 0, short = 0, problematic = 0;
  const examples = [];

  for (const file of files) {
    const full = path.join(DIR, file);
    const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
    obj.content = cleanContent(obj.content);
    fs.writeFileSync(full, JSON.stringify(obj, null, 2), 'utf8');

    const len = obj.content.length;
    if (len > 500) good++;
    else if (len >= 200) short++;
    else {
      problematic++;
      if (examples.length < 3) {
        examples.push({
          file,
          id: obj.id,
          title: obj.title,
          category: obj.category,
          length: len,
          content: obj.content
        });
      }
    }
  }

  const result = {
    totalFiles: files.length,
    goodOver500: good,
    usable200to500: short,
    problematicUnder200: problematic,
    examples
  };

  fs.writeFileSync(path.join(DIR, 'cleanup_report.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main();

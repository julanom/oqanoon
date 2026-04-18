const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://qanoon.om/wp-json/wp/v2';
const DELAY_MS = 1200;
const OUT_DIR = path.join(process.cwd(), 'laws', 'full');
const USER_AGENT = 'OpenClaw qanoon full scraper';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function htmlToText(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  const text = $.root().text()
    .replace(/[\u00a0\t]+/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
  return text;
}

function decodeHtml(html) {
  const $ = cheerio.load(`<div id="x">${html || ''}</div>`);
  return $('#x').text().trim();
}

function extractPrefix(slug) {
  const m = (slug || '').match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function detectCategoryFallback(slug) {
  const prefix = extractPrefix(slug);
  const map = {
    rd: 'مرسوم سلطاني',
    apsr: 'أمر سامي',
    fsa: 'قرار وزاري',
    mofa: 'قرار وزاري',
  };
  return map[prefix] || 'غير مصنف';
}

function extractNumberYear(title, slug) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const toAsciiDigits = s => (s || '').replace(/[٠-٩]/g, d => String(arabicIndic.indexOf(d)));

  const titleMatch = (title || '').match(/رقم\s+([^\n]+?)(?=\s+(?:ب|ل|في|بشأن|بإ|الصادر|الخاص)|$)/);
  if (titleMatch) {
    const raw = titleMatch[1]
      .replace(/\s*\/\s*/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
    const yearMatch = toAsciiDigits(raw).match(/(?:^|\/)(\d{4})(?:$|\/)/);
    return { number: raw, year: yearMatch ? yearMatch[1] : '' };
  }

  const asciiSlug = toAsciiDigits(slug || '');
  const slugMatch = asciiSlug.match(/([a-z]+)(\d{4})(\d{2,5})/i);
  if (slugMatch) {
    return { year: slugMatch[2], number: slugMatch[3].replace(/^0+/, '') || slugMatch[3] };
  }

  return { number: '', year: '' };
}

function buildLawRecord(post, categoryNames) {
  const title = decodeHtml(post.title?.rendered || '');
  const slug = post.slug || '';
  const { number, year } = extractNumberYear(title, slug);
  const content = htmlToText(post.content?.rendered || '');
  const categories = (post.categories || []).map(id => categoryNames.get(id)).filter(Boolean);
  let category = categories.find(c => c !== 'الجريدة الرسمية') || categories[0] || '';
  if (!category || category === 'Uncategorized') {
    category = detectCategoryFallback(slug);
  }

  return {
    id: slug || String(post.id),
    title,
    number,
    year,
    category,
    content,
    url: post.link,
  };
}

async function getAllCategories() {
  const map = new Map();
  let page = 1;
  while (true) {
    const res = await axios.get(`${BASE}/categories`, {
      params: { per_page: 100, page },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30000,
    });
    for (const cat of res.data) map.set(cat.id, cat.name);
    const totalPages = Number(res.headers['x-wp-totalpages'] || 1);
    if (page >= totalPages) break;
    page++;
    await sleep(300);
  }
  return map;
}

async function fetchPostsPage(page) {
  const res = await axios.get(`${BASE}/posts`, {
    params: { per_page: 100, page, _fields: 'id,slug,link,title,content,categories' },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 30000,
  });
  return { posts: res.data, totalPages: Number(res.headers['x-wp-totalpages'] || 1) };
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

async function main() {
  ensureDir(OUT_DIR);
  const errors = [];
  const records = [];
  const counts = {};
  const skipCategories = new Set(['الجريدة الرسمية']);

  console.log('Fetching categories...');
  const categoryNames = await getAllCategories();
  console.log(`Loaded ${categoryNames.size} categories`);

  console.log('Fetching first page to determine total pages...');
  const first = await fetchPostsPage(1);
  let totalPages = first.totalPages;
  console.log(`Total API pages: ${totalPages}`);

  for (let page = 1; page <= totalPages; page++) {
    let posts;
    try {
      const res = page === 1 ? first : await fetchPostsPage(page);
      posts = res.posts;
    } catch (err) {
      errors.push({ page, error: err.message });
      console.error(`[PAGE ERR] page=${page} :: ${err.message}`);
      continue;
    }

    for (const post of posts) {
      try {
        const names = (post.categories || []).map(id => categoryNames.get(id)).filter(Boolean);
        if (names.some(n => skipCategories.has(n))) continue;

        const record = buildLawRecord(post, categoryNames);
        const outPath = path.join(OUT_DIR, `${record.id}.json`);
        fs.writeFileSync(outPath, JSON.stringify(record, null, 2), 'utf8');
        records.push(record);
        counts[record.category] = (counts[record.category] || 0) + 1;

        if (records.length % 100 === 0) {
          console.log(`[PROGRESS] scraped=${records.length} errors=${errors.length} last=${record.id}`);
        }
      } catch (err) {
        errors.push({ url: post.link, error: err.message });
        console.error(`[POST ERR] ${post.link} :: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }
  }

  const index = records.map(({ content, ...meta }) => meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'errors.json'), JSON.stringify(errors, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'stats.json'), JSON.stringify({ total: records.length, counts, errors: errors.length }, null, 2), 'utf8');

  const sizeBytes = dirSizeBytes(OUT_DIR);
  console.log('\nFULL SCRAPE COMPLETE');
  console.log(`Total laws scraped: ${records.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Total size bytes: ${sizeBytes}`);
  console.log('Breakdown by category:');
  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`- ${k}: ${v}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

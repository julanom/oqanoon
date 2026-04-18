const { Pool } = require('pg');

const CONNECTION_STRING = process.env.CONNECTION_STRING;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!CONNECTION_STRING || !VOYAGE_API_KEY || !GROQ_API_KEY) {
  throw new Error('Missing required env vars: CONNECTION_STRING, VOYAGE_API_KEY, GROQ_API_KEY');
}

// Persistent connection pool — avoids opening/closing a connection per query
const pool = new Pool({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false }, max: 5 });
pool.on('error', (err) => console.error('[pool] unexpected error', err));

// In-memory query cache: normalized question -> { result, ts }
const queryCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(question) {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCached(question) {
  const key = cacheKey(question);
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { queryCache.delete(key); return null; }
  return entry.result;
}

function setCached(question, result) {
  queryCache.set(cacheKey(question), { result, ts: Date.now() });
}

function analyzeQuestion(question) {
  const q = question || '';
  let topic = 'عام';
  if (/(عمل|موظف|عامل|فصل|تعسفي|إجازة|أجر)/.test(q)) topic = 'عمل';
  else if (/(جزاء|عقوبة|عقوبات|تزوير|جريمة|جنائي)/.test(q)) topic = 'جزاء';
  else if (/(إيجار|مستأجر|مالك|عقد|مؤجر|إخلاء)/.test(q)) topic = 'إيجار';
  else if (/(شركة|تجاري|استثمار|شرك|تأسيس)/.test(q)) topic = 'تجاري';

  const stop = new Set(['ما','ماذا','كم','هل','في','من','على','عن','إلى','عند','هو','هي','حقوق','شروط','يستحق','عمان','انتهاء','العقد']);
  const keyTerms = q.replace(/[؟?.,،:؛!]/g, ' ').split(/\s+/).map(s=>s.trim()).filter(Boolean).filter(w=>!stop.has(w)).slice(0,8);
  const articleNumbers = [...q.matchAll(/(?:المادة|مادة)\s*\(?\s*(\d+)\s*\)?/g)].map(m=>m[1]);
  const lawNumbers = [...q.matchAll(/رقم\s*(\d+\s*\/\s*\d+)/g)].map(m=>m[1]);
  return { topic, keyTerms, articleNumbers, lawNumbers };
}

function topicTitleKeywords(topic) {
  const map = {
    'عمل': ['عمل','موظف','عامل'],
    'جزاء': ['جزاء','عقوبات'],
    'إيجار': ['إيجار','مستأجر','مالك'],
    'تجاري': ['تجار','شركة','استثمار']
  };
  return map[topic] || [];
}

async function embedQuery(question) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {'Content-Type':'application/json', Authorization:`Bearer ${VOYAGE_API_KEY}`},
    body: JSON.stringify({model:'voyage-law-2', input_type:'query', input:[question]})
  });
  if (!res.ok) throw new Error(`Voyage query embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

function sourceRelevant(title, topic) {
  const t = title || '';
  const keys = topicTitleKeywords(topic);
  return keys.some(k => t.includes(k));
}

async function semanticSearch(queryEmbedding, matchCount = 5) {
  const sql = `
    SELECT id, chunk_id, law_id, title, category, year, url, chunk_index, total_chunks, text, score
    FROM match_law_chunks($1::vector(1024), $2)
  `;
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;
  const { rows } = await pool.query(sql, [vectorLiteral, matchCount]);
  return rows.map(r => ({ ...r, score: Number(r.score || 0) }));
}

async function titleFilteredSearch(titleKeywords, limit = 5) {
  if (!titleKeywords || !titleKeywords.length) return [];
  const clauses = titleKeywords.map((_, i) => `title ILIKE $${i + 1}`);
  const sql = `
    SELECT law_id, title, category, year, url, chunk_id, chunk_index, total_chunks, text,
           0.75::float AS score
    FROM law_chunks
    WHERE ${clauses.join(' OR ')}
    ORDER BY chunk_index ASC NULLS LAST
    LIMIT ${Number(limit)}
  `;
  const { rows } = await pool.query(sql, titleKeywords.map(k => `%${k}%`));
  return rows;
}

async function keywordSearch(searchQuery, limit = 10) {
  const terms = (searchQuery || '').split(/\s+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const conditions = terms.map((_, i) => `text ILIKE $${i + 1}`);
  const scoreExpr = terms.map((_, i) => `CASE WHEN text ILIKE $${i + 1} THEN 1 ELSE 0 END`).join(' + ');
  const sql = `
    SELECT law_id, title, category, year, url, chunk_id, chunk_index, total_chunks, text,
           (${scoreExpr})::float AS score
    FROM law_chunks
    WHERE ${conditions.join(' OR ')}
    ORDER BY score DESC, chunk_index ASC NULLS LAST
    LIMIT ${Number(limit)}
  `;
  const { rows } = await pool.query(sql, terms.map(t => `%${t}%`));
  return rows.map(r => ({ ...r, score: Number(r.score || 0) }));
}

function mergeResults(globalSemantic, filteredSemantic, keyword, analysis) {
  const byId = new Map();
  const maxKeyword = Math.max(1e-9, ...keyword.map(r => Number(r.score || 0)), 1e-9);

  for (const r of globalSemantic) {
    byId.set(r.chunk_id, {
      ...r,
      semantic_score: Number(r.score || 0),
      filtered_bonus: 0,
      keyword_score: 0,
      topic_relevant: sourceRelevant(r.title, analysis.topic)
    });
  }
  for (const r of filteredSemantic) {
    if (byId.has(r.chunk_id)) {
      const row = byId.get(r.chunk_id);
      row.filtered_bonus = 1;
      row.topic_relevant = row.topic_relevant || sourceRelevant(r.title, analysis.topic);
    } else {
      byId.set(r.chunk_id, {
        ...r,
        semantic_score: 0,
        filtered_bonus: 1,
        keyword_score: 0,
        topic_relevant: sourceRelevant(r.title, analysis.topic)
      });
    }
  }
  for (const r of keyword) {
    const normKeyword = Number(r.score || 0) / maxKeyword;
    if (byId.has(r.chunk_id)) {
      byId.get(r.chunk_id).keyword_score = normKeyword;
    } else {
      byId.set(r.chunk_id, {
        ...r,
        semantic_score: 0,
        filtered_bonus: 0,
        keyword_score: normKeyword,
        topic_relevant: sourceRelevant(r.title, analysis.topic)
      });
    }
  }

  const merged = [...byId.values()].map(r => ({
    ...r,
    final_score: (r.semantic_score * 0.6) + (r.keyword_score * 0.2) + (r.filtered_bonus * 0.15) + (r.topic_relevant ? 0.05 : 0)
  }));
  merged.sort((a,b)=>b.final_score-a.final_score);
  return merged.slice(0,8);
}

function confidenceFromResults(results, analysis) {
  const top = results[0]?.final_score || 0;
  const relevantCount = results.filter(r => r.topic_relevant).length;
  if (top > 0.85 && relevantCount >= 3) return 'high';
  if (top > 0.70 || relevantCount >= 2) return 'medium';
  return 'low';
}

async function askGroq(question, chunks, history = []) {
  const context = chunks.map((c,i)=>`[#${i+1}]\nالعنوان: ${c.title}\nالتصنيف: ${c.category}\nالسنة: ${c.year||''}\nالمعرف: ${c.chunk_id}\nالرابط: ${c.url}\nالنص:\n${c.text}`).join('\n\n');
  const system = 'أنت مساعد قانوني متخصص في القانون العُماني. أجب على السؤال بناءً على النصوص القانونية المقدمة فقط. اذكر دائماً رقم المادة واسم القانون المصدر. إذا لم تجد إجابة في النصوص، قل ذلك صراحةً. لا تخترع معلومات.';
  const userContent = `السؤال:\n${question}\n\nالنصوص القانونية المتاحة:\n${context}\n\nأعطني إجابة عربية واضحة ومباشرة، ثم سطراً قصيراً بعنوان: المصادر.`;
  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userContent }
  ];
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json', Authorization:`Bearer ${GROQ_API_KEY}`},
    body: JSON.stringify({
      model:'openai/gpt-oss-120b',
      temperature:0.2,
      messages
    })
  });
  if (!res.ok) throw new Error(`Groq failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function queryLaw(question, history = []) {
  // Cache hit: skip embed + DB search + LLM (history excluded from cache key — follow-ups always go fresh)
  if (!history.length) {
    const cached = getCached(question);
    if (cached) { console.log('[cache] hit'); return cached; }
  }

  const analysis = analyzeQuestion(question);
  const queryEmbedding = await embedQuery(question);
  const [globalSemantic, filteredSemantic, keyword] = await Promise.all([
    semanticSearch(queryEmbedding, 5),
    titleFilteredSearch(topicTitleKeywords(analysis.topic), 5),
    keywordSearch(analysis.keyTerms.join(' '), 10)
  ]);
  const top = mergeResults(globalSemantic, filteredSemantic, keyword, analysis);
  const answer = await askGroq(question, top, history);
  const result = {
    answer,
    sources: top.map(c => ({ title:c.title, category:c.category, url:c.url, chunk_id:c.chunk_id, law_id: c.law_id, score: c.final_score })),
    confidence: confidenceFromResults(top, analysis),
    analysis
  };

  if (!history.length) setCached(question, result);
  return result;
}

module.exports = {
  queryLaw,
  analyzeQuestion,
  semanticSearch,
  keywordSearch,
  titleFilteredSearch,
  mergeResults
};

if (require.main === module) {
  (async()=>{
    const questions = [
      'كم يوم إجازة سنوية يستحق الموظف؟',
      'ما شروط تأسيس شركة في عمان؟',
      'ما حقوق المستأجر عند انتهاء العقد؟'
    ];
    const outputs = [];
    for (const q of questions) outputs.push({ question:q, result: await queryLaw(q) });
    console.log(JSON.stringify(outputs, null, 2));
  })().catch(err=>{console.error(err);process.exit(1)});
}

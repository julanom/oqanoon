const { requireEnv } = require('./config');
const {
  analyzeQuestion,
  buildClarifyingQuestion,
  confidenceFromResults,
  mergeResults,
  shouldAskClarifyingQuestion,
  topicTitleKeywords
} = require('./lib/query_analysis');
const { retryAsync, withTimeout } = require('./lib/resilience');
const { Pool } = require('pg');

const CONNECTION_STRING = requireEnv('CONNECTION_STRING');
const VOYAGE_API_KEY = requireEnv('VOYAGE_API_KEY');
const GROQ_API_KEY = requireEnv('GROQ_API_KEY');

const DB_QUERY_TIMEOUT_MS = 10_000;
const EMBEDDING_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 20_000;

// Persistent connection pool avoids opening/closing a connection per query.
const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 5,
  query_timeout: DB_QUERY_TIMEOUT_MS,
  statement_timeout: DB_QUERY_TIMEOUT_MS
});
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
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCached(question, result) {
  queryCache.set(cacheKey(question), { result, ts: Date.now() });
}

function logEvent(event, details = {}) {
  console.log(JSON.stringify({
    scope: 'query_law',
    event,
    at: new Date().toISOString(),
    ...details
  }));
}

async function embedQuery(question) {
  const res = await retryAsync(
    () => withTimeout(
      (signal) => fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOYAGE_API_KEY}` },
        body: JSON.stringify({ model: 'voyage-law-2', input_type: 'query', input: [question] }),
        signal
      }),
      { timeoutMs: EMBEDDING_TIMEOUT_MS, timeoutMessage: 'Voyage embedding request timed out' }
    ),
    {
      retries: 2,
      retryDelayMs: 400,
      onRetry: (error, attempt) => logEvent('embed_retry', { attempt, error: error.message })
    }
  );
  if (!res.ok) throw new Error(`Voyage query embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function semanticSearch(queryEmbedding, matchCount = 5) {
  const sql = `
    SELECT id, chunk_id, law_id, title, category, year, url, chunk_index, total_chunks, text, score
    FROM match_law_chunks($1::vector(1024), $2)
  `;
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;
  const startedAt = Date.now();
  const { rows } = await pool.query(sql, [vectorLiteral, matchCount]);
  logEvent('semantic_search', { matchCount, resultCount: rows.length, durationMs: Date.now() - startedAt });
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
  const startedAt = Date.now();
  const { rows } = await pool.query(sql, titleKeywords.map(k => `%${k}%`));
  logEvent('title_filtered_search', { limit, keywords: titleKeywords, resultCount: rows.length, durationMs: Date.now() - startedAt });
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
  const startedAt = Date.now();
  const { rows } = await pool.query(sql, terms.map(t => `%${t}%`));
  logEvent('keyword_search', { limit, terms, resultCount: rows.length, durationMs: Date.now() - startedAt });
  return rows.map(r => ({ ...r, score: Number(r.score || 0) }));
}

async function askGroq(question, chunks, history = []) {
  const context = chunks.map((c, i) => `[#${i + 1}]\nالعنوان: ${c.title}\nالتصنيف: ${c.category}\nالسنة: ${c.year || ''}\nالمعرف: ${c.chunk_id}\nالرابط: ${c.url}\nالنص:\n${c.text}`).join('\n\n');
  const system = 'أنت مساعد قانوني متخصص في القانون العماني. أجب على السؤال بناء على النصوص القانونية المقدمة فقط. اذكر دائما رقم المادة واسم القانون المصدر. إذا لم تجد إجابة في النصوص، قل ذلك صراحة. لا تخترع معلومات.';
  const userContent = `السؤال:\n${question}\n\nالنصوص القانونية المتاحة:\n${context}\n\nأعطني إجابة عربية واضحة ومباشرة، ثم سطرا قصيرا بعنوان: المصادر.`;
  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userContent }
  ];
  const res = await retryAsync(
    () => withTimeout(
      (signal) => fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          temperature: 0.2,
          messages
        }),
        signal
      }),
      { timeoutMs: LLM_TIMEOUT_MS, timeoutMessage: 'Groq completion request timed out' }
    ),
    {
      retries: 2,
      retryDelayMs: 500,
      onRetry: (error, attempt) => logEvent('llm_retry', { attempt, error: error.message })
    }
  );
  if (!res.ok) throw new Error(`Groq failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function queryLaw(question, history = []) {
  const startedAt = Date.now();
  if (!history.length) {
    const cached = getCached(question);
    if (cached) {
      logEvent('cache_hit', { questionPreview: question.slice(0, 80) });
      return cached;
    }
  }

  const analysis = analyzeQuestion(question);
  logEvent('query_started', {
    questionPreview: question.slice(0, 120),
    topic: analysis.topic,
    keyTerms: analysis.keyTerms,
    articleNumbers: analysis.articleNumbers,
    lawNumbers: analysis.lawNumbers,
    historyLength: history.length
  });
  const queryEmbedding = await embedQuery(question);
  const [globalSemantic, filteredSemantic, keyword] = await Promise.all([
    semanticSearch(queryEmbedding, 5),
    titleFilteredSearch(topicTitleKeywords(analysis.topic), 5),
    keywordSearch(analysis.keyTerms.join(' '), 10)
  ]);
  const top = mergeResults(globalSemantic, filteredSemantic, keyword, analysis);
  const confidence = confidenceFromResults(top);
  logEvent('retrieval_complete', {
    confidence,
    topScore: top[0]?.final_score || 0,
    resultCount: top.length,
    topSources: top.slice(0, 3).map(row => ({
      chunk_id: row.chunk_id,
      title: row.title,
      final_score: row.final_score,
      exact_reference_match: row.exact_reference_match
    })),
    durationMs: Date.now() - startedAt
  });

  if (shouldAskClarifyingQuestion(top, analysis)) {
    const result = {
      answer: buildClarifyingQuestion(question, analysis),
      sources: top.map(c => ({
        title: c.title,
        category: c.category,
        url: c.url,
        chunk_id: c.chunk_id,
        law_id: c.law_id,
        score: c.final_score
      })),
      confidence: 'low',
      analysis,
      needs_clarification: true
    };

    logEvent('clarification_requested', {
      confidence: result.confidence,
      topScore: top[0]?.final_score || 0,
      durationMs: Date.now() - startedAt
    });

    if (!history.length) setCached(question, result);
    return result;
  }

  const answer = await askGroq(question, top, history);
  const result = {
    answer,
    sources: top.map(c => ({ title: c.title, category: c.category, url: c.url, chunk_id: c.chunk_id, law_id: c.law_id, score: c.final_score })),
    confidence,
    analysis,
    needs_clarification: false
  };

  logEvent('query_completed', {
    confidence,
    sourceCount: result.sources.length,
    durationMs: Date.now() - startedAt
  });

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
  (async () => {
    const questions = [
      'كم يوم إجازة سنوية يستحق الموظف؟',
      'ما شروط تأسيس شركة في عمان؟',
      'ما حقوق المستأجر عند انتهاء العقد؟'
    ];
    const outputs = [];
    for (const q of questions) outputs.push({ question: q, result: await queryLaw(q) });
    console.log(JSON.stringify(outputs, null, 2));
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

require('./config');
const express = require('express');
const path = require('path');
const { queryLaw } = require('./query_law_improved');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Per-IP rate limiting
const rateMap = new Map();
const RATE_LIMIT_MS = 5000;

function checkRate(ip) {
  const now = Date.now();
  const last = rateMap.get(ip) || 0;
  if (now - last < RATE_LIMIT_MS) return Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
  rateMap.set(ip, now);
  return 0;
}

app.post('/api/ask', async (req, res) => {
  const { question, history } = req.body;

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'missing question' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'question too long (max 500 chars)' });
  }

  const wait = checkRate(req.ip);
  if (wait > 0) {
    return res.status(429).json({ error: `rate limited - wait ${wait}s`, retryAfter: wait });
  }

  try {
    const result = await queryLaw(question.trim(), history || []);
    res.json({
      answer: result.answer,
      confidence: result.confidence,
      sources: result.sources,
      topic: result.analysis?.topic,
      needs_clarification: !!result.needs_clarification
    });
  } catch (err) {
    console.error('[api/ask]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Oqanoon web server running on http://localhost:${PORT}`);
});

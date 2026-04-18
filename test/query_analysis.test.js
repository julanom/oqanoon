const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeQuestion,
  buildClarifyingQuestion,
  confidenceFromResults,
  extractArticleNumbers,
  mergeResults,
  normalizeLawNumber,
  referenceSignals,
  shouldAskClarifyingQuestion,
  topicTitleKeywords
} = require('../lib/query_analysis');

test('analyzeQuestion extracts topic and article references', () => {
  const analysis = analyzeQuestion('ما هي المادة 12 في قانون العمل رقم 3/2024؟');
  assert.equal(analysis.topic, 'عمل');
  assert.deepEqual(analysis.articleNumbers, ['12']);
  assert.deepEqual(analysis.lawNumbers, ['3/2024']);
});

test('topicTitleKeywords maps topic to search hints', () => {
  assert.deepEqual(topicTitleKeywords('إيجار'), ['إيجار', 'مستأجر', 'مالك']);
});

test('extractArticleNumbers supports article references in Arabic text', () => {
  assert.deepEqual(extractArticleNumbers('تنص المادة (12) على ما يلي'), ['12']);
  assert.deepEqual(extractArticleNumbers('راجع مادة 7 ثم المادة 11'), ['7', '11']);
});

test('normalizeLawNumber standardizes spacing and Arabic digits', () => {
  assert.equal(normalizeLawNumber('٣ / ٢٠٢٤'), '3/2024');
});

test('referenceSignals detects exact article and law number matches', () => {
  const signals = referenceSignals(
    {
      law_id: '3/2024',
      title: 'قانون العمل',
      text: 'تنص المادة 12 على استحقاق الإجازة السنوية.',
      url: 'https://example.com/law/3/2024',
      chunk_id: 'work-12'
    },
    {
      topic: 'عمل',
      articleNumbers: ['12'],
      lawNumbers: ['3/2024']
    }
  );

  assert.equal(signals.article_match_count, 1);
  assert.equal(signals.law_match_count, 1);
  assert.equal(signals.exact_reference_match, true);
});

test('mergeResults combines and sorts by final score', () => {
  const analysis = { topic: 'عمل' };
  const merged = mergeResults(
    [
      { chunk_id: 'a', title: 'قانون العمل', score: 0.9, url: 'u1' },
      { chunk_id: 'b', title: 'قانون الجزاء', score: 0.5, url: 'u2' }
    ],
    [{ chunk_id: 'a', title: 'قانون العمل', score: 0.75, url: 'u1' }],
    [{ chunk_id: 'b', title: 'قانون الجزاء', score: 3, url: 'u2' }],
    analysis
  );

  assert.equal(merged[0].chunk_id, 'a');
  assert.ok(merged[0].final_score > merged[1].final_score);
});

test('mergeResults boosts exact article and law matches above generic hits', () => {
  const merged = mergeResults(
    [
      {
        chunk_id: 'generic',
        law_id: '9/2020',
        title: 'قانون العمل',
        text: 'أحكام عامة في قانون العمل',
        url: 'https://example.com/9/2020',
        score: 0.95
      }
    ],
    [],
    [
      {
        chunk_id: 'exact',
        law_id: '3/2024',
        title: 'قانون العمل',
        text: 'المادة 12: يستحق العامل إجازة سنوية.',
        url: 'https://example.com/3/2024',
        score: 1
      }
    ],
    {
      topic: 'عمل',
      articleNumbers: ['12'],
      lawNumbers: ['3/2024']
    }
  );

  assert.equal(merged[0].chunk_id, 'exact');
  assert.equal(merged[0].exact_reference_match, true);
});

test('shouldAskClarifyingQuestion triggers when no strong evidence exists', () => {
  const shouldClarify = shouldAskClarifyingQuestion(
    [{ final_score: 0.2, topic_relevant: false, exact_reference_match: false }],
    { topic: 'عام', articleNumbers: [], lawNumbers: [] }
  );
  assert.equal(shouldClarify, true);
});

test('shouldAskClarifyingQuestion triggers when exact reference is requested but not found', () => {
  const shouldClarify = shouldAskClarifyingQuestion(
    [{ final_score: 0.75, topic_relevant: true, exact_reference_match: false }],
    { topic: 'عمل', articleNumbers: ['12'], lawNumbers: ['3/2024'] }
  );
  assert.equal(shouldClarify, true);
});

test('buildClarifyingQuestion asks for the missing legal reference cleanly', () => {
  const message = buildClarifyingQuestion('اشرح المادة 12', {
    topic: 'عمل',
    keyTerms: ['المادة', '12'],
    articleNumbers: ['12'],
    lawNumbers: []
  });

  assert.match(message, /المادة 12/);
  assert.match(message, /اسم القانون|الموضوع/);
});

test('confidenceFromResults reflects top score and relevance', () => {
  assert.equal(confidenceFromResults([{ final_score: 0.9, topic_relevant: true }, { final_score: 0.8, topic_relevant: true }, { final_score: 0.7, topic_relevant: true }]), 'high');
  assert.equal(confidenceFromResults([{ final_score: 0.2, topic_relevant: false }]), 'low');
});

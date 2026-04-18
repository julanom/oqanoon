const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReply,
  chunkText,
  getSmalltalkReply,
  looksLikeLegalQuestion,
  normalizeArabic
} = require('../lib/message_routing');

test('normalizeArabic removes diacritics and normalizes letter variants', () => {
  assert.equal(normalizeArabic('إجَازَة'), 'اجازه');
  assert.equal(normalizeArabic('مسؤولية'), 'مسؤوليه');
});

test('getSmalltalkReply handles Arabic greeting', () => {
  assert.match(getSmalltalkReply('السلام عليكم'), /وعليكم السلام/);
});

test('looksLikeLegalQuestion detects legal Arabic prompts', () => {
  assert.equal(looksLikeLegalQuestion('هل يجوز فصل الموظف بدون إنذار؟'), true);
  assert.equal(looksLikeLegalQuestion('كيف حالك اليوم'), false);
});

test('buildReply formats answer, confidence, and deduped sources', () => {
  const reply = buildReply({
    answer: 'هذه إجابة تجريبية.',
    confidence: 'medium',
    sources: [
      { title: 'قانون العمل', law_id: 'law-1', url: 'https://example.com/1' },
      { title: 'قانون العمل', law_id: 'law-1', url: 'https://example.com/1?dup=1' },
      { title: 'قانون الجزاء', law_id: 'law-2', url: 'https://example.com/2' }
    ]
  });

  assert.match(reply, /مستوى الثقة/);
  assert.match(reply, /متوسط/);
  assert.equal((reply.match(/https:\/\/example\.com/g) || []).length, 2);
});

test('buildReply formats clarification responses differently', () => {
  const reply = buildReply({
    answer: 'ما اسم القانون المقصود؟',
    confidence: 'low',
    needs_clarification: true,
    sources: []
  });

  assert.match(reply, /توضيح مطلوب/);
  assert.match(reply, /أحتاج تفاصيل إضافية/);
});

test('chunkText splits long content into bounded parts', () => {
  const text = `فقرة أولى\n${'أ'.repeat(100)}\n${'ب'.repeat(100)}`;
  const parts = chunkText(text, 120);
  assert.equal(parts.length, 2);
  assert.ok(parts.every(part => part.length <= 120));
});

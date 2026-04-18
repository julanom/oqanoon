function chunkText(text, max = 1800) {
  const parts = [];
  let remaining = text || '';
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt < max * 0.5) splitAt = remaining.lastIndexOf(' ', max);
    if (splitAt < max * 0.5) splitAt = max;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function normalizeArabic(text = '') {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0000-\u007F\u0600-\u06FF\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSmalltalkReply(text = '') {
  const raw = text.trim();
  const t = normalizeArabic(raw);
  if (!t) return null;

  const greetingOnly = /^(مرحبا|هلا|هلا والله|السلام عليكم|سلام|اهلا|اهلين|صباح الخير|مساء الخير|hi|hello|hey)$/i.test(raw) ||
    /^(مرحبا|هلا|السلام عليكم|سلام|اهلا|اهلين|صباح الخير|مساء الخير)$/.test(t);

  if (greetingOnly) {
    if (t.includes('صباح')) return 'صباح النور\nأنا حاضر إذا عندك سؤال أو استفسار قانوني.';
    if (t.includes('مساء')) return 'مساء النور\nأنا حاضر إذا عندك سؤال أو استفسار قانوني.';
    if (t.includes('السلام')) return 'وعليكم السلام ورحمة الله\nتفضل، كيف أقدر أفيدك؟';
    return 'هلا\nتفضل، كيف أقدر أفيدك؟';
  }

  const thanksOnly = /^(شكرا|مشكور|يعطيك العافيه|يعطيك العافية|thanks|thx)$/i.test(raw) ||
    /^(شكرا|مشكور|يعطيك العافيه|يعطيك العافيه جدا)$/.test(t);
  if (thanksOnly) return 'العفو';

  const whoAreYou = /(من انت|وش اسمك|ايش اسمك|وش تسوي|ماذا تفعل|what are you|who are you)/i.test(raw) ||
    /(من انت|وش اسمك|ايش اسمك|وش تسوي|ماذا تفعل)/.test(t);
  if (whoAreYou) return 'أنا **Oqanoon** - مساعد قانوني يشرح النصوص القانونية العمانية بشكل واضح ومختصر.';

  const statusChat = /(كيفك|شلونك|كيف الحال|اخبارك|عامل ايه)/i.test(raw) ||
    /(كيفك|شلونك|كيف الحال|اخبارك)/.test(t);
  if (statusChat) return 'بخير دامك بخير\nإذا عندك سؤال، أرسله لي.';

  return null;
}

function looksLikeLegalQuestion(text = '') {
  const t = normalizeArabic(text);
  if (!t) return false;
  const legalHints = [
    'قانون', 'الماده', 'ماده', 'مرسوم', 'نظام', 'لائحه', 'تشريع', 'حكم', 'نص',
    'يجوز', 'يحق', 'يستحق', 'يلزم', 'يحظر', 'يمنع', 'مسموح', 'ممنوع', 'حقوق', 'واجبات', 'التزام',
    'الايجار', 'مستاجر', 'مالك', 'مؤجر', 'اخلاء', 'عقد ايجار', 'شقه', 'سكن',
    'عمل', 'موظف', 'عامل', 'فصل', 'اجازه', 'راتب', 'اجر', 'تعويض', 'تعسفي', 'عقد عمل', 'ضمان اجتماعي', 'تقاعد', 'مكافاه',
    'شركه', 'تاسيس', 'تجاري', 'استثمار', 'شريك', 'ترخيص', 'سجل تجاري', 'افلاس', 'اندماج',
    'عقد', 'عقود', 'فسخ', 'انهاء', 'انتهاء العقد', 'محدده المده', 'مفتوحه', 'تجديد', 'شرط',
    'جزاء', 'عقوبه', 'غرامه', 'جريمه', 'سجن', 'حبس', 'تزوير', 'سرقه', 'اعتداء',
    'محكمه', 'دعوى', 'قضيه', 'حكم قضائي', 'استئناف', 'تقاضي', 'شكوى', 'بلاغ', 'محامي',
    'طلاق', 'زواج', 'خلع', 'نفقه', 'حضانه', 'ميراث', 'وصيه', 'احوال شخصيه',
    'مدني', 'ضرر', 'مسؤوليه', 'اهمال',
    'ايش يصير', 'وش يصير', 'وش الحكم', 'ايش الحكم', 'ايش القانون', 'وش القانون',
    'مشكله مع', 'نزاع', 'خلاف', 'حقي', 'حقوقي', 'اطالب',
    'كيف اشتكي', 'وين اشتكي', 'اقدر اشتكي', 'هل ممكن', 'هل يجوز',
    'الفرق بين', 'متى يحق', 'متى يجوز', 'ما العقوبه', 'كم العقوبه', 'كم الغرامه'
  ];
  return legalHints.some(k => t.includes(k)) || text.includes('؟') || text.includes('?');
}

function escapeMarkdown(text = '') {
  return text.replace(/([*_`~|\\])/g, '\\$1');
}

function formatSources(sources = [], limit = 3) {
  const byLaw = new Map();
  for (const s of sources) {
    if (!s.title || !s.url) continue;
    const key = s.law_id || `${s.title}||${s.url}`;
    if (!byLaw.has(key)) byLaw.set(key, s);
    if (byLaw.size >= limit) break;
  }
  return [...byLaw.values()].map(s => `- ${escapeMarkdown(s.title)}\n  <${s.url}>`).join('\n');
}

const CONFIDENCE_LABEL = { high: 'عالي', medium: 'متوسط', low: 'منخفض' };

function buildReply(result) {
  const confidenceLabel = CONFIDENCE_LABEL[result.confidence] || result.confidence;
  const title = result.needs_clarification ? '⚖️ **توضيح مطلوب:**' : '⚖️ **الإجابة:**';
  const disclaimer = result.needs_clarification
    ? '⚠️ *أحتاج تفاصيل إضافية حتى أقدم إجابة قانونية أدق*'
    : '⚠️ *هذه معلومة قانونية وليست استشارة قانونية*';
  return [
    title,
    result.answer,
    '',
    `📊 **مستوى الثقة:** ${confidenceLabel}`,
    disclaimer,
    '',
    '📚 **المصادر:**',
    formatSources(result.sources, 3) || '- لا توجد مصادر'
  ].join('\n');
}

module.exports = {
  buildReply,
  chunkText,
  formatSources,
  getSmalltalkReply,
  looksLikeLegalQuestion,
  normalizeArabic
};

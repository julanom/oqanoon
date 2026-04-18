function analyzeQuestion(question) {
  const q = question || '';
  let topic = 'عام';
  if (/(عمل|موظف|عامل|فصل|تعسفي|إجازة|اجر|أجر)/.test(q)) topic = 'عمل';
  else if (/(جزاء|عقوبة|عقوبات|تزوير|جريمة|جنائي)/.test(q)) topic = 'جزاء';
  else if (/(إيجار|مستأجر|مالك|عقد|مؤجر|إخلاء)/.test(q)) topic = 'إيجار';
  else if (/(طلاق|حضانة|نفقة|زواج|خلع|ميراث|وصية|عدة|عده|أحوال شخصية|احوال شخصية|ولاية|نسب)/.test(q)) topic = 'أحوال شخصية';
  else if (/(شركة|تجاري|استثمار|شرك|تأسيس)/.test(q)) topic = 'تجاري';

  const stop = new Set([
    'ما', 'ماذا', 'كم', 'هل', 'في', 'من', 'على', 'عن', 'إلى', 'عند', 'هو', 'هي',
    'حقوق', 'شروط', 'يستحق', 'عمان', 'انتهاء', 'العقد', 'اعني', 'يعني', 'يقول',
    'القانون', 'عن', 'حكم', 'احكام', 'أحكام'
  ]);
  const keyTerms = q
    .replace(/[؟?.,،:؛!]/g, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(w => !stop.has(w))
    .slice(0, 8);
  const articleNumbers = [...q.matchAll(/(?:المادة|مادة)\s*\(?\s*(\d+)\s*\)?/g)].map(m => m[1]);
  const lawNumbers = [...q.matchAll(/رقم\s*(\d+\s*\/\s*\d+)/g)].map(m => m[1]);
  return { topic, keyTerms, articleNumbers, lawNumbers };
}

function topicTitleKeywords(topic) {
  const map = {
    عمل: ['عمل', 'موظف', 'عامل'],
    جزاء: ['جزاء', 'عقوبات'],
    إيجار: ['إيجار', 'مستأجر', 'مالك'],
    'أحوال شخصية': ['أحوال شخصية', 'حضانة', 'طلاق', 'نفقة', 'زواج', 'ميراث'],
    تجاري: ['تجاري', 'شركة', 'استثمار']
  };
  return map[topic] || [];
}

function sourceRelevant(title, topic) {
  const t = title || '';
  const keys = topicTitleKeywords(topic);
  return keys.some(k => t.includes(k));
}

function normalizeDigits(text = '') {
  const easternArabicDigits = '٠١٢٣٤٥٦٧٨٩';
  return String(text).replace(/[٠-٩]/g, d => String(easternArabicDigits.indexOf(d)));
}

function normalizeLooseArabic(text = '') {
  return normalizeDigits(text)
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

function extractArticleNumbers(text = '') {
  const normalized = normalizeLooseArabic(text);
  const matches = [...normalized.matchAll(/(?:الماده|ماده)\s*\(?\s*(\d+)\s*\)?/g)];
  return matches.map(match => match[1]);
}

function normalizeLawNumber(value = '') {
  const normalized = normalizeDigits(String(value)).replace(/\s+/g, '');
  const match = normalized.match(/(\d+)\/(\d+)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function collectLawNumberCandidates(result) {
  return [
    result.law_id,
    result.title,
    result.url,
    result.text,
    result.chunk_id
  ]
    .map(normalizeLawNumber)
    .filter(Boolean);
}

function referenceSignals(result, analysis) {
  const textBundle = [result.title, result.text, result.chunk_id].filter(Boolean).join('\n');
  const requestedArticleNumbers = analysis.articleNumbers || [];
  const requestedLawNumbers = (analysis.lawNumbers || []).map(normalizeLawNumber).filter(Boolean);
  const articleHits = requestedArticleNumbers.filter(num => extractArticleNumbers(textBundle).includes(num));
  const candidateLawNumbers = collectLawNumberCandidates(result);
  const lawHits = requestedLawNumbers.filter(num => candidateLawNumbers.includes(num));

  return {
    article_match_count: articleHits.length,
    law_match_count: lawHits.length,
    exact_reference_match: articleHits.length > 0 || lawHits.length > 0
  };
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
      topic_relevant: sourceRelevant(r.title, analysis.topic),
      article_match_count: 0,
      law_match_count: 0,
      exact_reference_match: false
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
        topic_relevant: sourceRelevant(r.title, analysis.topic),
        article_match_count: 0,
        law_match_count: 0,
        exact_reference_match: false
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
        topic_relevant: sourceRelevant(r.title, analysis.topic),
        article_match_count: 0,
        law_match_count: 0,
        exact_reference_match: false
      });
    }
  }

  const merged = [...byId.values()].map(r => {
    const signals = referenceSignals(r, analysis);
    return {
      ...r,
      ...signals,
      final_score:
        (r.semantic_score * 0.42) +
        (r.keyword_score * 0.15) +
        (r.filtered_bonus * 0.1) +
        (r.topic_relevant ? 0.05 : 0) +
        (signals.article_match_count * 0.2) +
        (signals.law_match_count * 0.12) +
        (signals.exact_reference_match ? 0.15 : 0)
    };
  });
  merged.sort((a, b) => b.final_score - a.final_score);
  return merged.slice(0, 8);
}

function confidenceFromResults(results) {
  const top = results[0]?.final_score || 0;
  const relevantCount = results.filter(r => r.topic_relevant).length;
  if (top > 0.85 && relevantCount >= 3) return 'high';
  if (top > 0.70 || relevantCount >= 2) return 'medium';
  return 'low';
}

function shouldAskClarifyingQuestion(results, analysis) {
  const top = results[0]?.final_score || 0;
  const relevantCount = results.filter(r => r.topic_relevant).length;
  const exactReferenceCount = results.filter(r => r.exact_reference_match).length;
  const requestedExactReference = (analysis.articleNumbers?.length || 0) > 0 || (analysis.lawNumbers?.length || 0) > 0;

  if (results.length === 0) return true;
  if (requestedExactReference && exactReferenceCount === 0) return true;
  if (top < 0.35) return true;
  if (top < 0.5 && relevantCount === 0) return true;
  return false;
}

function buildClarifyingQuestion(question, analysis) {
  const keyTerms = (analysis.keyTerms || []).slice(0, 3);
  const articleNumbers = analysis.articleNumbers || [];
  const lawNumbers = analysis.lawNumbers || [];

  if (articleNumbers.length && lawNumbers.length) {
    return `لم أجد تطابقا واضحا للمادة ${articleNumbers[0]} في القانون رقم ${lawNumbers[0]}. هل يمكنك تأكيد رقم القانون أو إرسال اسم القانون كما هو مكتوب؟`;
  }
  if (articleNumbers.length) {
    return `ذكرت المادة ${articleNumbers[0]} لكن توجد احتمالات متعددة. ما اسم القانون أو الموضوع المرتبط بها؟`;
  }
  if (lawNumbers.length) {
    return `ذكرت القانون رقم ${lawNumbers[0]} لكن الموضوع ما زال عاما. هل تريد شرحا عن العمل أو الإيجار أو الجزاء أو موضوعا آخر داخل هذا القانون؟`;
  }
  if (analysis.topic && analysis.topic !== 'عام') {
    return `السؤال ما زال واسعًا بعض الشيء. هل تريد ${analysis.topic} في سياق محدد مثل مادة معينة أو حالة عملية أو اسم قانون بعينه؟`;
  }
  if (keyTerms.length) {
    return `حتى أجيب بدقة أكبر، هل يمكنك توضيح المقصود بـ ${keyTerms.join('، ')} أو ذكر اسم القانون أو رقم المادة؟`;
  }
  return `حتى أجيب بدقة، هل يمكنك ذكر اسم القانون أو رقم المادة أو وصف الحالة القانونية بشكل أوضح؟`;
}

module.exports = {
  analyzeQuestion,
  buildClarifyingQuestion,
  confidenceFromResults,
  extractArticleNumbers,
  mergeResults,
  normalizeLawNumber,
  referenceSignals,
  shouldAskClarifyingQuestion,
  sourceRelevant,
  topicTitleKeywords
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function fetchFilteredChunks(lawIds, keywordParts, limit = 100) {
  const lawFilter = `law_id.in.(${lawIds.join(',')})`;
  const orParts = keywordParts.map(k => `text.ilike.*${encodeURIComponent(k)}*`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/law_chunks?select=law_id,title,category,year,url,chunk_id,chunk_index,total_chunks,text&and=(${lawFilter})&or=(${orParts})&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase filtered fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function scoreChunk(text, keywords) {
  const t = String(text || '');
  let score = 0;
  for (const k of keywords) {
    const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = t.match(re);
    score += matches ? matches.length : 0;
  }
  return score;
}

async function askGroq(question, chunks) {
  const context = chunks.map((c,i)=>`[#${i+1}]\nالعنوان: ${c.title}\nالتصنيف: ${c.category}\nالمعرف: ${c.chunk_id}\nالرابط: ${c.url}\nالنص:\n${c.text}`).join('\n\n');
  const system = 'أنت مساعد قانوني متخصص في القانون العُماني. أجب على السؤال بناءً على النصوص القانونية المقدمة فقط. اذكر دائماً رقم المادة واسم القانون المصدر. إذا لم تجد إجابة في النصوص، قل ذلك صراحةً. لا تخترع معلومات.';
  const user = `السؤال:\n${question}\n\nالنصوص القانونية المتاحة:\n${context}\n\nأعطني إجابة عربية واضحة ومباشرة، ثم سطراً قصيراً بعنوان: المصادر.`;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json', Authorization:`Bearer ${GROQ_API_KEY}`},
    body: JSON.stringify({
      model:'openai/gpt-oss-120b',
      temperature:0.2,
      messages:[{role:'system', content:system},{role:'user', content:user}]
    })
  });
  if (!res.ok) throw new Error(`Groq failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function runQuestion(question, lawIds, keywords) {
  const chunks = await fetchFilteredChunks(lawIds, keywords, 200);
  const ranked = chunks
    .map(c => ({...c, score: scoreChunk((c.title || '') + ' ' + (c.text || ''), keywords)}))
    .sort((a,b)=>b.score-a.score)
    .slice(0,5);
  const answer = await askGroq(question, ranked);
  return {
    answer,
    sources: ranked.map(c => ({ title:c.title, category:c.category, url:c.url, chunk_id:c.chunk_id })),
    candidate_count: chunks.length
  };
}

(async()=>{
  const q2 = await runQuestion('ما عقوبة التزوير في عمان؟', ['rd1999077','rd2001072','rd2005075'], ['تزوير','التزوير','مزور','محرر','محررات','عقوبة','يعاقب']);
  const q3 = await runQuestion('ما حقوق الموظف عند الفصل التعسفي؟', ['rd2003035','rd2006074','rd2006112','rd1999071','rd1999084'], ['فصل','تعسفي','إنهاء','خدمة','تعويض','عمل','عامل']);
  console.log(JSON.stringify([
    { question: 'ما عقوبة التزوير في عمان؟', result: q2 },
    { question: 'ما حقوق الموظف عند الفصل التعسفي؟', result: q3 }
  ], null, 2));
})().catch(err=>{console.error(err);process.exit(1)});

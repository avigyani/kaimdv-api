// KAIMDV API - Gemini proxy. Key lives ONLY in Vercel env (GEMINI_KEY).
const KEY = process.env.GEMINI_KEY;
const ORIGIN = 'https://avigyani.github.io';

async function callGemini(model, body) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}

function partsOf(json) {
  if (json && json.candidates && json.candidates[0] && json.candidates[0].content) {
    return json.candidates[0].content.parts || [];
  }
  return [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!KEY) return res.status(500).json({ error: 'GEMINI_KEY missing' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  try {
    if (b.kind === 'edit') {
      const models = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image'];
      const payload = { contents: [{ parts: [
        { text: b.prompt || 'Edit this photo' },
        { inlineData: { mimeType: b.mime || 'image/jpeg', data: b.image } }
      ] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } };
      let lastErr = '';
      for (const m of models) {
        const out = await callGemini(m, payload);
        const parts = partsOf(out.json);
        const img = parts.find(p => p.inlineData);
        const txt = parts.filter(p => p.text).map(p => p.text).join('\n');
        if (img) {
          return res.status(200).json({ image: 'data:' + (img.inlineData.mimeType || 'image/png') + ';base64,' + img.inlineData.data, text: txt });
        }
        lastErr = (out.json && out.json.error && out.json.error.message) || ('HTTP ' + out.status);
      }
      return res.status(502).json({ error: lastErr || 'edit failed' });
    }
    const models = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
    const payload = { contents: [{ parts: [{ text: b.prompt || '' }] }] };
    let lastErr = '';
    for (const m of models) {
      const out = await callGemini(m, payload);
      const parts = partsOf(out.json);
      const txt = parts.filter(p => p.text).map(p => p.text).join('');
      if (txt) return res.status(200).json({ text: txt, model: m });
      lastErr = (out.json && out.json.error && out.json.error.message) || ('HTTP ' + out.status);
    }
    return res.status(502).json({ error: lastErr || 'text failed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};


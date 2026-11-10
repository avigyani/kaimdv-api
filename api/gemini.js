// KAIMDV API - Gemini proxy v4. Key lives ONLY in Vercel env (GEMINI_KEY).
// v4 changes (speed): new kind:'chat' — lite model first with a short
// timeout, for the English Kali app's short answers; voice now returns the
// raw WAV file instead of base64 JSON (about 1/3 fewer bytes on slow
// networks) and its per-model timeout is shorter.
// v2 changes: per-model timeout (a hung model no longer stalls everything),
// slow 3.8 model dropped, and a new kind:'voice' — Gemini AI voice (TTS model)
// returning WAV audio for the English Kali app.
// v3 changes: voice tries the newer TTS models first (3.1 / 3.8 series,
// Kannada supported, language auto-detected) — the 2.5 TTS previews shut
// down on 2026-11-17, so they are only a last resort now.
const KEY = process.env.GEMINI_KEY;
const ORIGIN = 'https://avigyani.github.io';

async function callGemini(model, body) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}

async function callGeminiVoice(model, body, ms) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms || 9000)
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

function wavWrap(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
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

    if (b.kind === 'voice') {
      const text = (b.text || '').slice(0, 400);
      if (!text) return res.status(400).json({ error: 'no text' });
      const langCode = (b.lang || '').toString();
      const mkBody = withLang => ({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: Object.assign(
            { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            (withLang && langCode) ? { languageCode: langCode } : {}
          )
        }
      });
      // 2.5 TTS previews shut down 2026-11-17; 3.x models auto-detect the
      // language (Kannada included), so try them first, without languageCode.
      const VMODELS = ['gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'];
      const attempts = VMODELS.map(m => ({ m, withLang: false }));
      if (langCode) { attempts.push({ m: VMODELS[0], withLang: true }); attempts.push({ m: VMODELS[1], withLang: true }); }
      let lastErr = '';
      for (const a of attempts) {
        let out;
        try { out = await callGeminiVoice(a.m, mkBody(a.withLang), 9000); } catch (e) { lastErr = String((e && e.message) || e); continue; }
        const parts = partsOf(out.json);
        const au = parts.find(p => p.inlineData && (p.inlineData.mimeType || '').indexOf('audio') === 0);
        if (au) {
          const pcm = Buffer.from(au.inlineData.data, 'base64');
          const mRate = /rate=(\d+)/.exec(au.inlineData.mimeType || '');
          const wav = wavWrap(pcm, mRate ? +mRate[1] : 24000);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('X-Voice-Model', a.m);
          return res.status(200).send(wav);
        }
        lastErr = (out.json && out.json.error && out.json.error.message) || ('HTTP ' + out.status);
        console.log('voice attempt failed:', a.m, a.withLang ? 'with-lang' : 'auto', lastErr);
      }
      return res.status(502).json({ error: lastErr || 'voice failed' });
    }

    if (b.kind === 'chat') {
      // Short app answers (tutor chat, translation): fastest model first.
      const models = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
      const payload = { contents: [{ parts: [{ text: b.prompt || '' }] }] };
      let lastErr = '';
      for (const m of models) {
        let out;
        try { out = await callGeminiVoice(m, payload, 12000); } catch (e) { lastErr = String((e && e.message) || e); continue; }
        const parts = partsOf(out.json);
        const txt = parts.filter(p => p.text).map(p => p.text).join('');
        if (txt) return res.status(200).json({ text: txt, model: m });
        lastErr = (out.json && out.json.error && out.json.error.message) || ('HTTP ' + out.status);
      }
      return res.status(502).json({ error: lastErr || 'chat failed' });
    }

    // kind 'text' (default)
    const models = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
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

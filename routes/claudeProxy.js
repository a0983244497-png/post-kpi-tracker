import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();

router.post('/', async (req, res) => {
  const { system, prompt } = req.body || {};
  if (!system || !prompt) {
    return res.status(400).json({ error: 'body 需包含 system 和 prompt 欄位' });
  }

  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_KEY 環境變數未設定' });
  }

  try {
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 1000,
    });

    const text = completion.choices[0]?.message?.content?.trim() || '';
    res.json({ text });
  } catch (e) {
    console.error('[claude-proxy] OpenAI error:', e.message);
    const status = e.status || 500;
    const msg = e.code === 'insufficient_quota'  ? 'OpenAI 額度已用盡'
               : e.code === 'invalid_api_key'    ? 'OpenAI 金鑰無效'
               : e.message || 'OpenAI 呼叫失敗';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: msg });
  }
});

export default router;

import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();

const FORMAT_RULES = {
  carousel:
    '本次產出類型為【carousel】。請嚴格依照系統提示中【carousel（輪播）】的格式輸出，不要輸出其他類型的格式，也不要額外加上其他類型的內容。務必產出完整 6 張，不可多於或少於 6 張。',

  cta:
    '本次產出類型為【cta】。請嚴格依照系統提示中【cta（行動呼籲）】的格式輸出，不要輸出其他類型的格式，也不要額外加上其他類型的內容。',
};

router.post('/', async (req, res) => {
  const { system, prompt, type } = req.body || {};
  if (!system || !prompt) {
    return res.status(400).json({ error: 'body 需包含 system 和 prompt 欄位' });
  }

  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_KEY 環境變數未設定' });
  }

  // single 已廢除，未知 type 一律 fallback 為 carousel
  const formatRule = FORMAT_RULES[type] ?? FORMAT_RULES.carousel;
  const fullSystem = `${system}\n\n${formatRule}`;

  try {
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: fullSystem },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 1500,
    });

    const text = completion.choices[0]?.message?.content?.trim() || '';
    res.json({ text });
  } catch (e) {
    console.error('[claude-proxy] OpenAI error:', e.message);
    const status = e.status || 500;
    const msg = e.code === 'insufficient_quota' ? 'OpenAI 額度已用盡'
               : e.code === 'invalid_api_key'   ? 'OpenAI 金鑰無效'
               : e.message || 'OpenAI 呼叫失敗';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: msg });
  }
});

export default router;

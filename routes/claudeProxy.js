import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();

const FORMAT_RULES = {
  carousel:
    '本次請依照系統提示中【輪播貼文格式】輸出，務必產出完整 6 張（第1張封面、第2–5張內容、第6張收尾），不可多於或少於 6 張。輸出只包含文案本身，不得出現 cta、carousel、single 等類型代號或任何欄位標記。',

  cta:
    '本次請依照系統提示中【行動呼籲貼文格式】輸出：第一句（25字以內）、空行、本文（60–100字）、空行、行動指令。三段之間用空行分隔，不得出現 cta、carousel、single 等類型代號、結構標籤或任何欄位名稱。',

  // 批量矩陣用：純文字單則，不加任何格式規則
  matrix: '',
  bio:    '',
};

router.post('/', async (req, res) => {
  const { system, prompt, type, max_tokens: reqMaxTokens } = req.body || {};
  if (!system || !prompt) {
    return res.status(400).json({ error: 'body 需包含 system 和 prompt 欄位' });
  }

  const apiKey = process.env.OPENAI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_KEY 環境變數未設定' });
  }

  // single 已廢除，未知 type 一律 fallback 為 carousel
  const formatRule = FORMAT_RULES[type] ?? FORMAT_RULES.carousel;
  const fullSystem = formatRule ? `${system}\n\n${formatRule}` : system;
  const maxTokens = Math.min(Math.max(parseInt(reqMaxTokens) || 1500, 100), 4096);

  try {
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: fullSystem },
        { role: 'user',   content: prompt },
      ],
      max_tokens: maxTokens,
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

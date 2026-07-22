import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();

const FORMAT_RULES = {
  single:
    '本次產出類型為【single（單篇）】。請只產出一則 Threads 貼文，嚴格遵守 SOP 中 single 的格式：Hook → 空行 → 本文 → 空行 → 結尾 → 空行 → ＊以上為個人操作習慣，非投資建議。不要分點、不要多則。',

  carousel:
    '本次產出類型為【carousel（輪播）】。請依 SOP 中 carousel 的格式，完整產出 7 張，不可少於 7 張。\n\n第 1 張為封面（標題 10 字以內、強烈對比或具體數字）；第 2–6 張為內容；第 7 張為 CTA（引導私訊或加群）。每張都必須包含三個欄位：\n標題：\n正文：\n視覺建議：\n\n整體語氣遵循 SOP 語氣規則。',

  cta:
    '本次產出類型為【cta（行動呼籲）】。請依 SOP 中 cta 的格式產出：Hook → 空行 → 本文（帶出群組或課程的實際價值，不賣夢）→ 空行 → 行動指令（私訊「關鍵字」或連結在限動）→ 空行 → ＊以上為個人操作習慣，非投資建議。語氣自然，不強迫。',
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

  const formatRule = FORMAT_RULES[type] ?? FORMAT_RULES.single;
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

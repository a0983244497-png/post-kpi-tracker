import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();

const FORMAT_RULES = {
  single:
    '本次產出類型為【單篇 Threads 文案】。請產出一則完整的 Threads 貼文，遵循原本 SOP 的 Hook／本文／結尾三段格式，只產出這一則，不要分點、不要多則。',

  carousel:
    '本次產出類型為【7 張輪播貼文】。請產出剛好 7 張輪播的內容，每一張都必須包含「標題」與「正文」兩部分。格式請明確分張列出，例如：\n\n第 1 張\n標題：xxx\n正文：xxx\n\n第 2 張\n標題：xxx\n正文：xxx\n\n（依此類推到第 7 張）\n\n第 1 張作為開頭要有吸引力的 Hook，最後一張（第 7 張）要收尾並帶一句引導互動。務必產出完整 7 張，不可少於 7 張。整體語氣仍遵循原本 SOP。',

  cta:
    '本次產出類型為【CTA 行動呼籲文案】。請產出一則以「引導讀者採取行動」為目的的文案，行動目標是引導加入社群（Telegram 群組）或報名課程。文案要自然、不要過度推銷、不要用「保證獲利」這類禁語，結尾要有明確但不強迫的行動呼籲（例如引導私訊、點連結、加群）。仍遵循原本 SOP 的品牌語氣。',
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

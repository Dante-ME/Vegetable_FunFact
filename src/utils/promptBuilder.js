import { TONE_PROMPTS, DEFAULT_TONE } from '../config/textModel.config.js';

const SYSTEM_INSTRUCTION =
  'Kamu adalah asisten yang menulis ulang sebuah fakta sayuran ke dalam gaya bahasa tertentu. ' +
  'Aturan penting: jangan menambahkan informasi baru, jangan mengubah makna atau angka yang sudah ' +
  'ada, dan jangan mengulang kata atau frasa. Jawab HANYA dengan satu kalimat hasil tulis ulang, ' +
  'tanpa basa-basi pembuka atau penutup.';

/**
 * Builds the chat-formatted prompt sent to the text-generation model to
 * restyle `originalFact` into `tone`, without changing its meaning.
 *
 * The model is used purely as a stylistic rewriter here - it is never asked
 * to supply facts of its own, only to reword ones it is given.
 */
export function buildToneRewritePrompt(originalFact, tone) {
  const toneInstruction = TONE_PROMPTS[tone] ?? TONE_PROMPTS[DEFAULT_TONE];

  return [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    {
      role: 'user',
      content:
        `Fakta asli: "${originalFact}"\n` +
        `Gaya bahasa: ${toneInstruction}\n` +
        'Tulis ulang fakta tersebut sesuai gaya bahasa di atas.',
    },
  ];
}

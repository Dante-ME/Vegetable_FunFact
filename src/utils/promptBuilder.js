import { TONE_PROMPTS, DEFAULT_TONE } from '../config/textModel.config.js';

const INSTRUCTION =
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
 *
 * Everything is folded into a single user-role message rather than split
 * across a system + user turn: not every chat template used by the models
 * in TEXT_MODEL_REGISTRY defines a dedicated system-role turn (Gemma's does
 * not), so keeping the whole instruction in the user message is the one
 * form guaranteed to be honored consistently regardless of which model is
 * active.
 */
export function buildToneRewritePrompt(originalFact, tone) {
  const toneInstruction = TONE_PROMPTS[tone] ?? TONE_PROMPTS[DEFAULT_TONE];

  return [
    {
      role: 'user',
      content:
        `${INSTRUCTION}\n\n` +
        `Fakta asli: "${originalFact}"\n` +
        `Gaya bahasa: ${toneInstruction}\n` +
        'Tulis ulang fakta tersebut sesuai gaya bahasa di atas.',
    },
  ];
}

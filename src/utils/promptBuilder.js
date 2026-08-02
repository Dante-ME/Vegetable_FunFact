import { TONE_PROMPTS, DEFAULT_TONE } from '../config/textModel.config.js';

const WORD_LIMIT = 30;

/**
 * Builds the chat-formatted prompt sent to the text-generation model to
 * generate a brand-new fun fact about a detected vegetable, in the
 * selected tone.
 *
 * The model's raw output is displayed to the user as-is (see
 * RootFactsService) - there is no local knowledge base behind this and no
 * rewriting step afterward, so this prompt is the only lever available for
 * keeping the result on-topic, appropriately short, and free of invented
 * specifics: it names the vegetable directly as the subject, bounds length
 * and scope explicitly, and asks only for common, well-established
 * information rather than precise-sounding numbers.
 */
export function buildFunFactPrompt(vegetableLabel, tone) {
  const toneInstruction = TONE_PROMPTS[tone] ?? TONE_PROMPTS[DEFAULT_TONE];

  return [
    {
      role: 'user',
      content:
        `Tuliskan TEPAT SATU fakta menarik dan singkat tentang ${vegetableLabel}.\n\n` +
        'Aturan yang wajib dipatuhi:\n' +
        `(1) Hanya bahas ${vegetableLabel}, jangan menyebutkan sayuran atau makanan lain.\n` +
        `(2) Maksimal ${WORD_LIMIT} kata.\n` +
        '(3) Sampaikan fakta yang masuk akal secara ilmiah dan umum diketahui, jangan mengarang ' +
        'angka atau statistik yang tidak pasti.\n' +
        '(4) Jangan menyebutkan bahwa kamu adalah AI, model bahasa, atau asisten.\n' +
        `(5) Gaya bahasa: ${toneInstruction}\n` +
        'Jawab HANYA dengan satu kalimat fakta tersebut, tanpa basa-basi pembuka atau penutup.',
    },
  ];
}

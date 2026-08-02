import { TONE_PROMPTS, DEFAULT_TONE } from '../config/textModel.config.js';

const WORD_LIMIT = 25;

/**
 * Builds the chat-formatted prompt sent to the text-generation model to
 * generate a brand-new fun fact about a detected vegetable, in the
 * selected tone.
 *
 * Everything - task, style examples, and rules - is folded into a single
 * user-role message rather than split across a system + user turn. This
 * shape was originally forced by Gemma's chat template, which has no
 * dedicated system-role turn. SmolLM2 does support a system turn, so the
 * single-message shape is now a choice rather than a constraint: it is the
 * arrangement the rules and examples above were actually tuned against, so
 * it is kept as-is. Splitting the rules into a system turn is a plausible
 * future tweak, but it would be a prompt change to re-test on its own, not
 * part of the model swap.
 *
 * Two short examples are included to anchor the exact target shape (starts
 * with the vegetable, one concise clause, ends cleanly) rather than relying
 * on the rules list alone to convey it - "Carrots contain beta-carotene..."
 * is a much stronger signal of what a good answer looks like than a word
 * count by itself.
 *
 * The model's raw output is displayed to the user as-is (see
 * RootFactsService) - there is no local knowledge base backing this and no
 * rewriting step afterward, so this prompt is the only lever available for
 * keeping the result on-topic, short, and free of invented specifics.
 */
export function buildFunFactPrompt(vegetableLabel, tone) {
  const toneInstruction = TONE_PROMPTS[tone] ?? TONE_PROMPTS[DEFAULT_TONE];

  return [
    {
      role: 'user',
      content:
        `Write exactly one short, factual sentence about ${vegetableLabel}.\n\n` +
        'Examples of the exact style to follow:\n' +
        'Carrots contain beta-carotene, which the body converts into vitamin A.\n' +
        'Corn naturally grows in several colors, including blue and purple.\n\n' +
        'Rules:\n' +
        `- The sentence must be specifically about ${vegetableLabel}.\n` +
        `- Mention "${vegetableLabel}" only once, at or near the start.\n` +
        `- One sentence only, maximum ${WORD_LIMIT} words.\n` +
        '- State an objective, educational fact - no opinions, no exaggeration.\n' +
        '- Do not start with "The vegetable...", "Here is...", or any introduction.\n' +
        '- No markdown, no bullet points, no lists.\n' +
        '- No AI or assistant references.\n' +
        `- ${toneInstruction}\n\n` +
        'Write only the sentence, nothing else.',
    },
  ];
}

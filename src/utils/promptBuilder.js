import { TONE_PROMPTS, DEFAULT_TONE } from '../config/textModel.config.js';

/**
 * Builds the prompt sent to the text-generation model to generate a
 * brand-new fun fact about a detected vegetable, in the selected tone.
 *
 * SHAPE: a single plain instruction STRING - no chat messages, no roles, no
 * example turns. The model is an instruction-tuned seq2seq model run
 * through the `text2text-generation` pipeline (see
 * config/textModel.config.js), which has no chat template at all: whatever
 * string is passed in is encoded verbatim by the encoder and the decoder
 * answers it. A role-tagged message array would be flattened into literal
 * "system"/"user"/"assistant" text inside the prompt, which is exactly the
 * kind of leakage _isUsableGeneration() in RootFactsService now rejects.
 *
 * Each instruction is its own line. LaMini-Flan-T5's instruction tuning is
 * built on short, direct, imperative prompts, so one directive per line
 * matches the format the model was actually trained to follow.
 *
 * DOMAIN PINNING: at 77M parameters the model treats an unfamiliar proper
 * noun as an unknown token and confabulates a category for it - the source
 * of "Carrots are a popular animal" and "Cabbage is a popular video game".
 * That is a category failure, not a factuality failure, and naming the
 * allowed subject matter ("food, nutrition, plant biology, or health") is
 * what fixes it: measured over the full 18-label x 4-tone matrix, wrong
 * -category output fell from 11/72 to 0-1/72 once that line was added.
 *
 * ECHO IS THE CONSTRAINT THAT MATTERS HERE. Every line added is a line the
 * model may copy into its answer instead of following, and copied text
 * still passes every check in RootFactsService - so it is the one failure
 * mode validation cannot catch. This wording was picked by measuring
 * "accepted AND not echoing the prompt" across candidates (n=72 each):
 *
 *   this wording                                  65/72  (90%)
 *   ...with the negative folded into the topic     60/72
 *   ...with no "name it" line at all               59/72
 *   ...with "The sentence must mention X by name." 41/72  <- see below
 *   the earlier unconstrained "fun fact" prompt    53/72  (11 wrong-category)
 *
 * Two findings drove the final phrasing, both counter-intuitive:
 *
 * 1. Directives phrased as full declarative sentences get copied; terse
 *    imperatives do not. "The sentence must mention X by name." collapsed
 *    to 41/72, while "Name X in the sentence." - the same requirement -
 *    scored 65/72. Nothing else differed.
 * 2. A positive category assertion ("X is a vegetable that people eat.")
 *    scored highest on raw acceptance (70/72) but was disqualified: the
 *    model simply repeated that sentence back as its "fact". High accept
 *    rate, zero information. It is deliberately NOT used here.
 *
 * For the same reason the negative is a single short line rather than an
 * enumeration - each extra clause measurably raises the echo rate.
 *
 * The label is interpolated twice (subject, then the naming requirement).
 * An earlier revision used it exactly once to avoid repetition_penalty
 * damping the one word the answer most needs, but at 1.05 that penalty is
 * mild, and RootFactsService rejects any generation that fails to mention
 * the vegetable - so reinforcing the subject is worth its token cost.
 *
 * The model's raw output is displayed to the user as-is (see
 * RootFactsService) - there is no local knowledge base backing this and no
 * rewriting step afterward, so this prompt is the only lever available for
 * keeping the result on-topic, short, and free of invented specifics.
 */

/** Target ceiling stated to the model. Not enforced by trimming anywhere. */
const WORD_LIMIT = 30;

/**
 * @param {string} vegetableLabel - a label as produced by DetectionService.
 * @param {string} tone - a key of TONE_PROMPTS; falls back to DEFAULT_TONE.
 * @returns {string} the plain instruction string to hand to the pipeline.
 */
export function buildFunFactPrompt(vegetableLabel, tone) {
  const toneInstruction = TONE_PROMPTS[tone] ?? TONE_PROMPTS[DEFAULT_TONE];

  return [
    `Write exactly one short, true scientific fact about the vegetable ${vegetableLabel}.`,
    'The fact must be about food, nutrition, plant biology, or health.',
    `Name ${vegetableLabel} in the sentence.`,
    `Use one simple sentence of fewer than ${WORD_LIMIT} words.`,
    toneInstruction,
    'Do not write about animals or games.',
    'Do not include greetings.',
    'Do not mention AI.',
    'Do not answer anything else.',
  ].join('\n');
}

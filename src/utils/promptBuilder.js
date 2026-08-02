import { TONE_PROMPTS, DEFAULT_TONE } from '../config/textModel.config.js';

/**
 * Builds the chat-formatted prompt sent to the text-generation model to
 * generate a brand-new fun fact about a detected vegetable, in the
 * selected tone.
 *
 * SHAPE: system turn, then three user/assistant example turns, then a bare
 * user turn holding only the vegetable label. Three properties of
 * SmolLM2-135M-Instruct drive that shape:
 *
 * 1. Its chat template injects a default persona when the first message is
 *    not a system message:
 *      {% if loop.first and messages[0]['role'] != 'system' %}
 *        "You are a helpful AI assistant named SmolLM, trained by Hugging Face"
 *    An earlier version of this prompt sent a single user turn, so that
 *    persona was silently prepended to every request. A "helpful AI
 *    assistant" answers conversationally and asks for clarification, which
 *    is exactly the failure that was observed ("To clarify this answer
 *    further please provide it as such..."). Supplying our own system
 *    message as messages[0] suppresses it - this is the only way to do so,
 *    since the injection is in the template, not in our code.
 *
 * 2. The examples are real conversation turns, not prose inside one user
 *    message. The template renders each as
 *      <|im_start|>assistant\n<one sentence><|im_end|>
 *    and <|im_end|> IS the model's EOS token. So every example demonstrates
 *    "emit one sentence, then stop", which is what makes the model halt on
 *    its own. Length is not enforced by truncating output anywhere - there
 *    is no post-processing step in this project.
 *
 * 3. All negative rules ("no markdown", "do not start with...") were
 *    removed. At 135M parameters negation is unreliable, and naming the
 *    unwanted string puts its tokens in context, which raises rather than
 *    lowers its probability. The examples demonstrate compliance instead;
 *    demonstration is this model class's strongest capability and
 *    instruction-following its weakest.
 *
 * The label is interpolated EXACTLY ONCE, in the final user turn. That is
 * deliberate: repetition_penalty applies across the whole prompt, not just
 * generated tokens (see GENERATION_DEFAULTS in textModel.config.js), so
 * each extra mention actively suppressed the one word the answer most
 * needs.
 *
 * The model's raw output is displayed to the user as-is (see
 * RootFactsService) - there is no local knowledge base backing this and no
 * rewriting step afterward, so this prompt is the only lever available for
 * keeping the result on-topic, short, and free of invented specifics.
 */

/** Target ceiling stated to the model. Not enforced by trimming anywhere. */
const WORD_LIMIT = 30;

/**
 * Fixed demonstrations of the exact target behavior.
 *
 * The vegetables here are deliberately NOT in src/data/facts.json's label
 * set (the classifier's vocabulary), so a detected vegetable can never
 * match an example and get echoed back verbatim instead of prompting a new
 * fact.
 *
 * The three facts are intentionally of different kinds - physical,
 * taxonomic, historical - so the model generalizes "state one interesting
 * fact" rather than locking onto a single sentence template. Each begins
 * with the vegetable, stays under the word limit, and ends with a period.
 */
const EXAMPLES = [
  {
    vegetable: 'Asparagus',
    fact: 'Asparagus can grow more than twenty centimetres in a single day during warm weather.',
  },
  {
    vegetable: 'Radish',
    fact: 'Radishes belong to the mustard family, which gives them their sharp, peppery bite.',
  },
  {
    vegetable: 'Celery',
    fact: 'Celery was woven into funeral wreaths in ancient Greece long before it became a common food.',
  },
];

/**
 * Tone is carried in the system turn rather than in the user turns. The
 * user turns must stay bare vegetable names so the final one matches the
 * pattern the examples establish; adding a tone marker only to the last
 * one would break that pattern, and adding it to all of them would teach
 * the model to ignore it (the fixed example answers cannot vary by tone).
 * The practical trade-off is that tone influences register more weakly
 * than the examples influence shape - accepted deliberately, since shape
 * compliance is what was actually failing.
 */
function buildSystemMessage(toneInstruction) {
  return [
    'You are a vegetable encyclopedia.',
    '',
    'The user gives you the name of a vegetable. You reply with one interesting, true fact about that vegetable.',
    '',
    `Your reply is always a single plain sentence of fewer than ${WORD_LIMIT} words that begins with the vegetable's name and ends with a period.`,
    '',
    toneInstruction,
  ].join('\n');
}

export function buildFunFactPrompt(vegetableLabel, tone) {
  const toneInstruction = TONE_PROMPTS[tone] ?? TONE_PROMPTS[DEFAULT_TONE];

  return [
    { role: 'system', content: buildSystemMessage(toneInstruction) },
    ...EXAMPLES.flatMap(({ vegetable, fact }) => [
      { role: 'user', content: vegetable },
      { role: 'assistant', content: fact },
    ]),
    { role: 'user', content: vegetableLabel },
  ];
}

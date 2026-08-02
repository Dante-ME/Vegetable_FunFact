import { TONE_CONFIG } from '../utils/config.js';

/**
 * Single source of truth for the text-generation model RootFactsService
 * uses to generate a fun fact directly from a detected vegetable label.
 *
 * To swap to a different decoder-only chat-formatted model, change
 * TEXT_MODEL_ID/TEXT_MODEL_DTYPE_BY_BACKEND below - RootFactsService and
 * TextGenerationClient never reference a specific model id, so that alone
 * is a config-only change. Swapping to a text2text-generation (T5-family)
 * model instead would be a bigger change: that pipeline type takes a plain
 * instruction string, not a chat-message array, so promptBuilder.js and
 * TextGenerationClient's generate() would need to change too - this
 * project briefly used one (Xenova/LaMini-Flan-T5-77M) and reverted after
 * real-world testing showed unreliable instruction-following (prompt
 * leakage, ignoring the detected vegetable).
 */
/**
 * Hugging Face repo id the weights are fetched from, in `owner/name` form.
 * transformers.js resolves it against the Hub the way the library intends,
 * so no host or path-template override is involved anywhere in this project.
 *
 * The default below is this project's own copy of the model, so a clone with
 * no .env downloads from it directly. Set VITE_HF_MODEL_ID at build time to
 * point the app at a different repo instead.
 *
 * Whatever id is used must be a PUBLIC repo: the browser fetches these files
 * with no credentials, and shipping a Hub token in client-side JS would leak
 * it to every visitor. It must also keep the upstream file layout, including
 * the onnx/ subdirectory - see docs/huggingface-model-upload.md.
 *
 * The string is validated by transformers.js with isValidHfModelId()
 * (utils/hub.js), which throws before any network request on a malformed id
 * - so a full URL is not accepted here, and "--" is not allowed in the name.
 */
export const TEXT_MODEL_ID =
  import.meta.env.VITE_HF_MODEL_ID || 'DanteME/SmolLM2-135M-Instruct';
export const TEXT_MODEL_TASK = 'text-generation';

// dtypeByBackend lets each candidate backend load the ONNX weight variant
// that actually suits it - q4f16's fp16 activations are tuned for WebGPU's
// compute shaders, while the WASM/CPU fallback uses plain q4 instead, which
// is the more broadly-supported quantization there. Unlike the T5 model
// this project briefly used, SmolLM2 is decoder-only, not seq2seq, so it
// isn't affected by the WebGPU q8-seq2seq-decoder bug that forced WASM-only
// there - both backends are safe to offer here.
//
// q4f16-on-WebGPU is specifically why this project is no longer on
// gemma-3-270m-it: that export overflows in fp16 under ONNX Runtime Web and
// emits repeated <unused56> filler instead of text (microsoft/onnxruntime
// issue #26732), so its only fast browser path was numerically broken.
// SmolLM2 is a LlamaForCausalLM export, which is the most heavily exercised
// architecture on this runtime, so q4f16 here is the mainstream path rather
// than a lightly-tested one.
export const TEXT_MODEL_DTYPE_BY_BACKEND = {
  webgpu: 'q4f16',
  wasm: 'q4',
};

export const TEXT_MODEL_BACKEND_PREFERENCE = ['webgpu', 'wasm'];

/** How long we wait for a generation before giving up and reporting failure. */
export const GENERATION_TIMEOUT_MS = 6000;

/**
 * How long we wait for the text-generation model itself to download and
 * initialize before giving up. Deliberately left at the value tuned for the
 * previous, much larger model: this one's q4f16 weights are ~118MB (vs
 * ~273MB before) and ship as a single .onnx file rather than a small graph
 * plus a separate multi-hundred-MB .onnx_data blob, so the same budget is
 * now generous headroom rather than a tight fit. generateFacts() awaits
 * this directly, so an unbounded wait here would hang the whole
 * detection-to-display flow.
 */
export const MODEL_LOAD_TIMEOUT_MS = 60000;

/**
 * Generation parameters for the fun-fact generation call.
 *
 * do_sample is true with a low temperature and top_p - deliberately NOT
 * pure greedy decoding. Greedy decoding was tried with the previous (T5)
 * model and had a real, observed cost: when a small model has any bias
 * toward a specific wrong output (there, generating "Soybean" regardless
 * of the actual detected vegetable), greedy decoding locks that bias in
 * deterministically on every single call, since there is no randomness to
 * ever escape it. A low temperature keeps generation close to the model's
 * most confident, safest continuation - serving "factual output" and
 * "reduced hallucination" - while still being genuine sampling rather than
 * one fixed path, which is "deterministic enough" (consistent almost all
 * of the time) rather than perfectly deterministic (identically wrong
 * every time, if the model is ever wrong). top_p additionally restricts
 * sampling to the model's high-confidence tokens only, so the small amount
 * of randomness introduced can't wander into a rare, potentially
 * fabricated continuation. repetition_penalty/no_repeat_ngram_size stay on
 * regardless of decoding strategy - they guard against a different failure
 * mode (degenerate repetition loops) that both greedy and sampled decoding
 * are prone to.
 *
 * Both penalties are set LOW on purpose. In transformers.js they are scored
 * over the entire sequence, prompt included, not just the generated tokens
 * - RepetitionPenaltyLogitsProcessor iterates `new Set(input_ids[i])` and
 * NoRepeatNGramLogitsProcessor calls calcBannedNgramTokens(input_ids[i])
 * (generation/logits_process.js), and the library's own docstring notes
 * "for decoder-only models like most LLMs, the considered tokens include
 * the prompt". Two consequences drove these values:
 *
 * - repetition_penalty was 1.3, which divided the logit of every token
 *   already in the prompt - including the detected vegetable's name, the
 *   one word the answer most needs. That pushed generation toward generic
 *   filler and away from the actual subject. 1.05 still damps runaway
 *   loops without penalizing the subject out of the output.
 * - no_repeat_ngram_size was 3. promptBuilder.js now puts three example
 *   sentences in context, and banning every 3-gram that appears in them
 *   bans ordinary English connectives, forcing contorted phrasing. At 6,
 *   a blocked repeat is almost certainly a degenerate loop rather than
 *   normal language, so the loop protection survives intact.
 */
export const GENERATION_DEFAULTS = {
  max_new_tokens: 48,
  do_sample: true,
  temperature: 0.3,
  top_p: 0.85,
  repetition_penalty: 1.05,
  no_repeat_ngram_size: 6,
};

/** Falls back to this tone if an unknown/unset tone value is requested. */
export const DEFAULT_TONE = TONE_CONFIG.defaultTone;

/**
 * English instruction fragment per tone, used when building the generation
 * prompt. Keys MUST stay in sync with TONE_CONFIG.availableTones in
 * src/utils/config.js (that file defines which tones the UI offers).
 *
 * Kept in English deliberately. SmolLM2's model card states it "primarily
 * understands and generates content in English", so English is not just the
 * language the target outputs for this prompt redesign were written in - it
 * is also the language this model is actually strongest in.
 */
export const TONE_PROMPTS = {
  normal: 'Write in a plain, neutral, informative tone.',
  professional: 'Write like a brief, formal science-textbook explanation.',
  casual: 'Write like you are casually telling a friend, using everyday language.',
  funny: 'Write in a playful, lighthearted tone, with a fun comparison.',
};

/** True if `tone` has a matching prompt instruction defined above. */
export function isValidTone(tone) {
  return Object.prototype.hasOwnProperty.call(TONE_PROMPTS, tone);
}

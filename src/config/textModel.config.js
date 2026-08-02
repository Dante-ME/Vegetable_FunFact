import { TONE_CONFIG } from '../utils/config.js';

/**
 * Single source of truth for the text-generation model RootFactsService
 * uses to generate a fun fact directly from a detected vegetable label.
 *
 * The model is an instruction-tuned seq2seq (T5-family) model run through
 * the `text2text-generation` pipeline, so the prompt is a single plain
 * instruction STRING, not a chat-message array with roles - see
 * utils/promptBuilder.js. Swapping to another text2text-generation model is
 * a config-only change here, since RootFactsService and
 * TextGenerationClient never reference a specific model id.
 */
/**
 * Hugging Face repo id the weights are fetched from, in `owner/name` form.
 * transformers.js resolves it against the Hub the way the library intends,
 * so no host or path-template override is involved anywhere in this project.
 *
 * The default below is the upstream Xenova ONNX export of the model, so a
 * clone with no .env downloads from it directly. Set VITE_HF_MODEL_ID at
 * build time to point the app at a different (e.g. self-hosted) copy.
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
  import.meta.env.VITE_HF_MODEL_ID || 'Xenova/LaMini-Flan-T5-77M';
export const TEXT_MODEL_TASK = 'text2text-generation';

// Quantized loading, at q8 rather than q4. Counter-intuitively, q4 is the
// BIGGER download for this particular repo - measured from the Hub's blob
// sizes:
//
//   variant     encoder    decoder_merged   total
//   q4           74.2 MB      88.1 MB      162.2 MB
//   q8 (this)    34.1 MB      56.6 MB       90.7 MB
//   fp32        134.9 MB     222.0 MB      356.9 MB
//
// Xenova's q4 export only converts MatMul weights to 4-bit and leaves the
// large tensors (notably the shared embedding table) at full precision,
// while the `_quantized` (q8) export int8-quantizes broadly. So q8 is both
// still genuinely quantized - nowhere near the 357 MB fp32 model - and
// roughly 71 MB smaller than q4, with no upside lost on this backend: q4's
// advantage is WebGPU int4 matmul kernels, and WebGPU is not offered for
// this model (see TEXT_MODEL_BACKEND_PREFERENCE below). q8 is also what
// transformers.js itself defaults to for the wasm device
// (DEFAULT_DEVICE_DTYPE_MAPPING in utils/dtypes.js).
//
// This is why the app failed at runtime on q4: loading 162 MB took ~9.6
// minutes end to end in Chrome, and generateFacts() awaits that load, so
// any interruption inside that window left isModelLoaded false and
// surfaced as the "Gagal membuat fakta menarik" error state.
//
// dtypeByBackend is kept as a per-device map so re-enabling another backend
// stays a one-line change.
export const TEXT_MODEL_DTYPE_BY_BACKEND = {
  webgpu: 'q4',
  wasm: 'q8',
};

// WASM-only, deliberately. This is an encoder-decoder (seq2seq) model, and
// its decoder is the case ONNX Runtime Web has historically mis-executed
// under WebGPU - the same reason this project ran T5 on WASM before. A bad
// WebGPU run still *loads* successfully and only produces garbage text, so
// selectFirstWorkingBackend's load-failure fallback would never catch it;
// not offering the backend at all is the only reliable guard. At 77M
// parameters the WASM path is fast enough that this costs little.
export const TEXT_MODEL_BACKEND_PREFERENCE = ['wasm'];

/** How long we wait for a generation before giving up and reporting failure. */
export const GENERATION_TIMEOUT_MS = 6000;

/**
 * How long we wait for the text-generation model itself to download and
 * initialize before giving up. generateFacts() awaits the load directly, so
 * without this the whole detection-to-display flow can hang indefinitely on
 * a stalled download - RootFactsService.loadModel() enforces it.
 *
 * Its job is to bound a HANG, not to enforce a UX budget, so it is set well
 * above the expected load rather than close to it. That distinction matters
 * here: this constant was previously declared but never actually applied to
 * anything, so its old 60s value had never been checked against a real
 * download. Chrome pulled the 162 MB q4 variant at roughly 290 KB/s in
 * testing, which puts the 90.7 MB q8 variant at very roughly 5 minutes on
 * that connection - a 60s cap would have turned a slow-but-working load
 * into a guaranteed failure, which is the exact bug this round is fixing.
 * 10 minutes leaves about 2x headroom over that measurement.
 *
 * This is the one number here worth re-tuning against your own connection;
 * it trades "user waits longer before seeing an error" against "a slow
 * network is wrongly reported as a failure".
 */
export const MODEL_LOAD_TIMEOUT_MS = 600000;

/**
 * Generation parameters for the fun-fact generation call.
 *
 * do_sample is true with a low temperature and top_p - deliberately NOT
 * pure greedy decoding. Greedy decoding was tried with a T5 model before
 * and had a real, observed cost: when a small model has any bias toward a
 * specific wrong output (there, generating "Soybean" regardless of the
 * actual detected vegetable), greedy decoding locks that bias in
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
 * Both penalties are set LOW on purpose. repetition_penalty was 1.3, which
 * pushed generation toward generic filler and away from the actual subject
 * - the detected vegetable's name is exactly the token the answer most
 * needs to be able to repeat, since _isUsableGeneration() now requires it
 * to appear. 1.05 still damps runaway loops without penalizing the subject
 * out of the output. no_repeat_ngram_size was 3, which bans ordinary
 * English connectives and forces contorted phrasing; at 6, a blocked repeat
 * is almost certainly a degenerate loop rather than normal language, so the
 * loop protection survives intact.
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
 * Kept in English deliberately. LaMini-Flan-T5 is instruction-tuned on an
 * English instruction dataset, so English is not just the language the
 * target outputs for this prompt were written in - it is also the language
 * this model is actually strongest in.
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

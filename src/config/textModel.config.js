import { TONE_CONFIG } from '../utils/config.js';

/**
 * Single source of truth for which text-generation model RootFactsService
 * uses to generate a fun fact directly from a detected vegetable label.
 *
 * To swap models (e.g. Gemma 3 270M -> Qwen2.5 0.5B, or any future model),
 * change ACTIVE_TEXT_MODEL_KEY below to another key from TEXT_MODEL_REGISTRY.
 * No other file needs to change - RootFactsService and TextGenerationClient
 * only ever read the *active* entry, never a hardcoded model id.
 */
// dtypeByBackend lets each candidate backend load the ONNX weight variant
// that actually suits it - q4f16's fp16 activations are tuned for WebGPU's
// compute shaders, while the WASM/CPU fallback uses plain q4 instead, which
// is the more broadly-supported quantization there.
export const TEXT_MODEL_REGISTRY = {
  'gemma3-270m': {
    label: 'Gemma 3 270M Instruct (ONNX)',
    modelId: 'onnx-community/gemma-3-270m-it-ONNX',
    task: 'text-generation',
    dtypeByBackend: {
      webgpu: 'q4f16',
      wasm: 'q4',
    },
  },
  'qwen2.5-0.5b': {
    label: 'Qwen2.5 0.5B Instruct (ONNX)',
    modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    task: 'text-generation',
    dtypeByBackend: {
      webgpu: 'q4f16',
      wasm: 'q4',
    },
  },
};

/** The only line that needs to change to switch the active text model. */
export const ACTIVE_TEXT_MODEL_KEY = 'gemma3-270m';

/** Resolves the full config object for the currently active model. */
export function getActiveTextModelConfig() {
  const modelConfig = TEXT_MODEL_REGISTRY[ACTIVE_TEXT_MODEL_KEY];

  if (!modelConfig) {
    throw new Error(
      `textModel.config.js: "${ACTIVE_TEXT_MODEL_KEY}" is not a known entry in TEXT_MODEL_REGISTRY.`,
    );
  }

  return modelConfig;
}

/**
 * Backend order to attempt when loading the model, best first.
 * TextGenerationClient falls back to the next entry if one fails to load.
 */
export const BACKEND_PREFERENCE = ['webgpu', 'wasm'];

/**
 * Default generation parameters for the fun-fact generation call.
 *
 * Kept deliberately conservative: this text is displayed to the user
 * verbatim with no rewriting step afterward, so temperature and top_p stay
 * low enough to keep the model close to its most likely, on-topic
 * continuation rather than wandering into unrelated or invented content.
 */
export const GENERATION_DEFAULTS = {
  max_new_tokens: 70,
  temperature: 0.5,
  top_p: 0.9,
  repetition_penalty: 1.3,
  no_repeat_ngram_size: 3,
  do_sample: true,
};

/**
 * Per-tone overrides merged on top of GENERATION_DEFAULTS (see
 * getGenerationConfig below). Temperature is the lever that actually
 * separates how literal vs. how freely-worded a tone reads: professional
 * stays closest to the model's safest continuation, funny is allowed the
 * most room for livelier word choice - but every value here stays inside a
 * conservative band, never approaching the kind of high temperature that
 * would risk drifting off-topic. This is what lets tone differences come
 * from configuration alone, with no tone-specific branching inside
 * RootFactsService or TextGenerationClient.
 */
export const GENERATION_OVERRIDES_BY_TONE = {
  normal: {},
  professional: { temperature: 0.3 },
  casual: { temperature: 0.55 },
  funny: { temperature: 0.7 },
};

/** Resolves the generation parameters to use for a given tone. */
export function getGenerationConfig(tone) {
  const overrides = GENERATION_OVERRIDES_BY_TONE[tone] ?? {};
  return { ...GENERATION_DEFAULTS, ...overrides };
}

/** How long we wait for a generation before giving up and reporting failure. */
export const GENERATION_TIMEOUT_MS = 8000;

/** Falls back to this tone if an unknown/unset tone value is requested. */
export const DEFAULT_TONE = TONE_CONFIG.defaultTone;

/**
 * Natural-language instruction fragment per tone, used when building the
 * generation prompt. Keys MUST stay in sync with TONE_CONFIG.availableTones
 * in src/utils/config.js (that file defines which tones the UI offers).
 *
 * Each one names a concrete register and at least one concrete stylistic
 * device (an opener, a comparison, a vocabulary choice) rather than a bare
 * adjective - a small model follows "use an everyday comparison" far more
 * reliably than it follows "be funny" alone. Content-preservation rules
 * (don't invent facts, stay on topic) live in the base prompt instead of
 * here, since there's no longer an "original" per tone to protect - only
 * the writing style is this file's concern.
 */
export const TONE_PROMPTS = {
  normal:
    'netral: satu kalimat informasi biasa yang lugas, tanpa gaya bahasa tambahan apa pun',
  professional:
    'seperti penjelasan guru IPA di depan kelas atau kalimat di buku pelajaran: gunakan istilah ' +
    'yang tepat serta kalimat yang runtut dan berwibawa, tanpa basa-basi santai atau candaan',
  casual:
    'seperti sedang cerita ke teman dekat: gunakan kata sehari-hari, boleh dibuka dengan sapaan ' +
    'santai seperti "Eh, tau nggak..." atau "Btw..."',
  funny:
    'seperti bercanda dengan teman: boleh bandingkan faktanya dengan hal receh sehari-hari yang ' +
    'tidak terduga, boleh pakai tanda seru atau ekspresi berlebihan',
};

/** True if `tone` has a matching prompt instruction defined above. */
export function isValidTone(tone) {
  return Object.prototype.hasOwnProperty.call(TONE_PROMPTS, tone);
}

import { TONE_CONFIG } from '../utils/config.js';

/**
 * Single source of truth for which text-generation model RootFactsService
 * uses to rewrite the tone of a verified fact.
 *
 * To swap models (e.g. Gemma 3 270M -> Qwen2.5 0.5B, or any future model),
 * change ACTIVE_TEXT_MODEL_KEY below to another key from TEXT_MODEL_REGISTRY.
 * No other file needs to change - RootFactsService and TextGenerationClient
 * only ever read the *active* entry, never a hardcoded model id.
 */
export const TEXT_MODEL_REGISTRY = {
  'gemma3-270m': {
    label: 'Gemma 3 270M Instruct (ONNX)',
    modelId: 'onnx-community/gemma-3-270m-it-ONNX',
    task: 'text-generation',
    dtype: 'q4f16',
  },
  'qwen2.5-0.5b': {
    label: 'Qwen2.5 0.5B Instruct (ONNX)',
    modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    task: 'text-generation',
    dtype: 'q4f16',
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

/** Default generation parameters for the tone-rewrite call. */
export const GENERATION_DEFAULTS = {
  max_new_tokens: 60,
  temperature: 0.6,
  repetition_penalty: 1.3,
  no_repeat_ngram_size: 3,
  do_sample: true,
};

/** How long we wait for a rewrite before falling back to the verified fact. */
export const GENERATION_TIMEOUT_MS = 8000;

/** Falls back to this tone if an unknown/unset tone value is requested. */
export const DEFAULT_TONE = TONE_CONFIG.defaultTone;

/**
 * Natural-language instruction fragment per tone, used when building the
 * rewrite prompt. Keys MUST stay in sync with TONE_CONFIG.availableTones
 * in src/utils/config.js (that file defines which tones the UI offers).
 */
export const TONE_PROMPTS = {
  normal: 'netral dan informatif',
  funny: 'lucu dan ringan, boleh sedikit bercanda, tapi makna faktanya tidak boleh berubah',
  professional: 'formal, seperti penjelasan ilmiah singkat',
  casual: 'santai, seperti sedang mengobrol dengan teman',
};

/** True if `tone` has a matching prompt instruction defined above. */
export function isValidTone(tone) {
  return Object.prototype.hasOwnProperty.call(TONE_PROMPTS, tone);
}

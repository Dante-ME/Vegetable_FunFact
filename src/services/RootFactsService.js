import { TextGenerationClient } from './TextGenerationClient.js';
import { buildFunFactPrompt } from '../utils/promptBuilder.js';
import { logError, withTimeout } from '../utils/common.js';
import {
  TEXT_MODEL_ID,
  TEXT_MODEL_TASK,
  TEXT_MODEL_DTYPE_BY_BACKEND,
  TEXT_MODEL_BACKEND_PREFERENCE,
  TEXT_MODEL_HOST,
  TEXT_MODEL_PATH_TEMPLATE,
  GENERATION_DEFAULTS,
  GENERATION_TIMEOUT_MS,
  DEFAULT_TONE,
  isValidTone,
} from '../config/textModel.config.js';

/** Maximum character length a generation is allowed before it's treated as unusable. */
const MAX_GENERATION_LENGTH = 400;

/**
 * Turns a detected vegetable label directly into the fun fact shown to the
 * user, generated live by a small Transformers.js text-generation model
 * (see config/textModel.config.js for which one).
 *
 * There is no local content behind this: generateFacts() either returns a
 * freshly-generated sentence from the model, or null if the model can't be
 * loaded, times out, or its output looks unusable. A null result is the
 * caller's signal to show an error state - this service never substitutes
 * any other content for it.
 *
 * Which model is used is entirely controlled by config/textModel.config.js -
 * this class never references a specific model id, so swapping to a
 * different text2text-generation model is a config-only change.
 */
export class RootFactsService {
  constructor() {
    this.textClient = null;
    this.isModelLoaded = false;
    this.isGenerating = false;
    this.currentTone = DEFAULT_TONE;

    // Holds the in-flight load promise so concurrent callers all await the
    // same real operation instead of one returning early while a load is
    // still genuinely in progress (see loadModel()) - the same single-flight
    // pattern CameraService.startCamera() uses for the same reason.
    this._loadModelPromise = null;

    // [PERF] Counts real executions of _loadModelInternal - should print 1
    // for the whole session no matter how many detections happen, proving
    // loadModel()'s single-flight guard actually prevents reloading.
    this._loadInternalCallCount = 0;
  }

  /**
   * Lazily creates and loads the configured text model. Safe to call
   * multiple times - a no-op once loaded, and concurrent calls made while a
   * load is already in flight all await that same load rather than one of
   * them resolving early before it's actually done.
   *
   * Deliberately UNBOUNDED (no timeout): model loading is one-time
   * initialization, not inference, so it's allowed to run to completion
   * rather than being raced against a clock. This used to be wrapped in
   * withTimeout(), which caused a real bug: when a load happened to take
   * longer than the timeout, the race settled and _loadModelPromise/
   * isModelLoaded reset to "not loaded" while the real pipeline() call kept
   * running unseen in the background. The next detection then saw no
   * load in flight and started a SECOND TextGenerationClient/pipeline()
   * call, competing with the first for bandwidth and CPU (and leaking the
   * first one's ONNX session, never disposed) - visible in practice as
   * _loadModelInternal's call count climbing past 1 and the model never
   * finishing a clean download into transformers.js's cache. Removing the
   * race means _loadModelPromise now tracks the REAL load() promise end to
   * end, so every caller - concurrent or sequential retries alike - always
   * joins the one true in-flight (or already-finished) load.
   *
   * Deliberately does NOT set any permanent "give up" flag on failure: a
   * genuine network error or no working backend is caught and logged here,
   * but isModelLoaded simply stays false, so the *next* call to loadModel()
   * - including the one generateFacts() makes automatically - retries. A
   * transient failure never permanently disables generation for the rest
   * of the session. That retry reuses the SAME TextGenerationClient (see
   * _loadModelInternal) rather than creating another one, since a failed
   * load leaves its pipelineInstance untouched (still null), so calling
   * load() again on it is exactly as safe as calling it the first time.
   */
  async loadModel() {
    if (this.isModelLoaded) return;

    if (this._loadModelPromise) {
      return this._loadModelPromise;
    }

    this._loadModelPromise = this._loadModelInternal().finally(() => {
      this._loadModelPromise = null;
    });

    return this._loadModelPromise;
  }

  async _loadModelInternal() {
    this._loadInternalCallCount += 1;
    console.log(`[PERF] _loadModelInternal execution count (expect always 1): ${this._loadInternalCallCount}`);

    try {
      // Created once and reused on every retry - never replaced - so at
      // most one TextGenerationClient (and therefore at most one underlying
      // pipeline()/model download) can ever exist for this service instance.
      if (!this.textClient) {
        this.textClient = new TextGenerationClient({
          modelId: TEXT_MODEL_ID,
          task: TEXT_MODEL_TASK,
          dtypeByBackend: TEXT_MODEL_DTYPE_BY_BACKEND,
          backendPreference: TEXT_MODEL_BACKEND_PREFERENCE,
          modelHost: TEXT_MODEL_HOST,
          pathTemplate: TEXT_MODEL_PATH_TEMPLATE,
        });
      }

      await this.textClient.load();
      this.isModelLoaded = true;
    } catch (error) {
      logError('RootFactsService.loadModel', error);
      this.isModelLoaded = false;
    }
  }

  /** Sets the tone used for future generations; falls back to the default on an unknown value. */
  setTone(tone) {
    this.currentTone = isValidTone(tone) ? tone : DEFAULT_TONE;
  }

  isReady() {
    return this.isModelLoaded;
  }

  /** Which device the model ended up loading on ('webgpu' | 'wasm' | null if not loaded). */
  getActiveBackend() {
    return this.textClient?.resolvedDevice ?? null;
  }

  /**
   * Generates a fun fact about `vegetableLabel` in the current tone,
   * directly from the text-generation model - the label is used as the
   * prompt subject itself, not to look anything up.
   *
   * If the model isn't loaded yet, this loads it first, so the very first
   * detection of a session gets a genuine attempt instead of an instant
   * failure. If that load fails, a generation is already in flight, the
   * call times out, or the output looks unusable, this returns null and
   * never substitutes any other content.
   *
   * @param {string} vegetableLabel - a label as produced by DetectionService.
   * @returns {Promise<string|null>} the generated fact, or null on any failure.
   */
  async generateFacts(vegetableLabel) {
    console.log('[DEBUG 2] RootFactsService.generateFacts received label:', vegetableLabel);

    // [PERF] Total request timer - covers the ENTIRE method, including any
    // model load it triggers, not just the generation call. Logged at every
    // return point below so a null/early-exit path is timed too, not just
    // the success path.
    const totalStart = performance.now();
    const logTotal = (path) => {
      console.log(`[PERF] Total request: ${(performance.now() - totalStart).toFixed(1)} ms (path: ${path})`);
    };

    if (!vegetableLabel) {
      logTotal('no label provided');
      return null;
    }

    if (!this.isModelLoaded) {
      const modelLoadStart = performance.now();
      await this.loadModel();
      console.log(`[PERF] loadModel() await inside generateFacts(): ${(performance.now() - modelLoadStart).toFixed(1)} ms`);
    }

    if (!this.isModelLoaded || this.isGenerating) {
      logTotal(!this.isModelLoaded ? 'model not loaded' : 'generation already in flight');
      return null;
    }

    this.isGenerating = true;
    const generationPromise = this._generateFact(vegetableLabel, this.currentTone);

    // Transformers.js gives no way to cancel an in-flight pipeline call, so
    // withTimeout() below only stops *this method* from waiting on it - the
    // real call keeps running in the background. isGenerating is therefore
    // released here, tied to generationPromise itself settling, instead of
    // in a `finally` on the timeout race: if the timeout wins, the flag
    // stays true for as long as the real call is still running, so any
    // generateFacts() call made in that window safely returns null instead
    // of starting a second invocation against the same pipeline instance.
    generationPromise.catch(() => {}).finally(() => {
      this.isGenerating = false;
    });

    try {
      const generated = await withTimeout(generationPromise, GENERATION_TIMEOUT_MS);

      const validateStart = performance.now();
      const usable = this._isUsableGeneration(generated);
      console.log(`[PERF] Post process - validation (usability check): ${(performance.now() - validateStart).toFixed(1)} ms`);

      logTotal(usable ? 'success' : 'unusable output rejected');
      return usable ? generated : null;
    } catch (error) {
      logError('RootFactsService.generateFacts', error);
      logTotal('timeout or error');
      return null;
    }
  }

  async _generateFact(vegetableLabel, tone) {
    const promptBuildStart = performance.now();
    const messages = buildFunFactPrompt(vegetableLabel, tone);
    console.log(`[PERF] Prompt build: ${(performance.now() - promptBuildStart).toFixed(1)} ms`);

    console.log('[DEBUG 3] Full prompt/messages sent to TextGenerationClient:', JSON.stringify(messages, null, 2));
    const result = await this.textClient.generate(messages, GENERATION_DEFAULTS);
    console.log('[DEBUG 6] Final extracted text returned by TextGenerationClient:', JSON.stringify(result));
    return result;
  }

  /**
   * Cheap guard against obviously broken output (empty, a runaway wall of
   * repeated text, or a sentence cut off mid-thought) from a small model.
   * This is not a fact-checker or a rewriter - it only accepts or rejects
   * the text wholesale, never edits it. The trailing-punctuation check
   * specifically catches generations that hit max_new_tokens before
   * reaching a natural stopping point: that reads as a broken app to the
   * user, so it's treated the same as any other generation failure (falls
   * back to the existing error state) rather than being shown truncated.
   */
  _isUsableGeneration(text) {
    if (typeof text !== 'string') return false;

    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length >= MAX_GENERATION_LENGTH) return false;

    return /[.!?]$/.test(trimmed);
  }

  /** Releases the loaded model's resources, if any. */
  async dispose() {
    await this.textClient?.dispose();
    this.isModelLoaded = false;
  }
}

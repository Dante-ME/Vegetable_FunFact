import { TextGenerationClient } from './TextGenerationClient.js';
import { buildFunFactPrompt } from '../utils/promptBuilder.js';
import { logError, withTimeout } from '../utils/common.js';
import {
  getActiveTextModelConfig,
  BACKEND_PREFERENCE,
  getGenerationConfig,
  GENERATION_TIMEOUT_MS,
  DEFAULT_TONE,
  isValidTone,
} from '../config/textModel.config.js';

/** Maximum character length a generation is allowed before it's treated as unusable. */
const MAX_GENERATION_LENGTH = 400;

/**
 * Turns a detected vegetable label directly into the fun fact shown to the
 * user, generated live by the configured text-generation model.
 *
 * There is no local content behind this: generateFacts() either returns a
 * freshly-generated sentence from the model, or null if the model can't be
 * loaded, times out, or its output looks unusable. A null result is the
 * caller's signal to show an error state - this service never substitutes
 * any other content for it.
 *
 * Which model is used is entirely controlled by config/textModel.config.js -
 * this class never references a specific model id, so swapping models is a
 * one-line config change, not a code change.
 */
export class RootFactsService {
  constructor() {
    this.textClient = null;
    this.isModelLoaded = false;
    this.isLoadingModel = false;
    this.isGenerating = false;
    this.currentTone = DEFAULT_TONE;
  }

  /**
   * Lazily creates and loads the currently configured text model. Safe to
   * call multiple times - a no-op once loaded, and a no-op if a load is
   * already in flight (rather than starting a second overlapping one).
   *
   * Deliberately does NOT set any permanent "give up" flag on failure: bad
   * config, a network error, or no working backend are all caught and
   * logged here, but isModelLoaded simply stays false, so the *next* call
   * to loadModel() - including the one generateFacts() makes automatically
   * below - retries from scratch. A transient failure never permanently
   * disables generation for the rest of the session.
   */
  async loadModel() {
    if (this.isModelLoaded || this.isLoadingModel) return;

    this.isLoadingModel = true;
    try {
      const { modelId, task, dtypeByBackend } = getActiveTextModelConfig();

      this.textClient = new TextGenerationClient({
        modelId,
        task,
        dtypeByBackend,
        backendPreference: BACKEND_PREFERENCE,
      });

      await this.textClient.load();
      this.isModelLoaded = true;
    } catch (error) {
      logError('RootFactsService.loadModel', error);
      this.isModelLoaded = false;
    } finally {
      this.isLoadingModel = false;
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
    if (!vegetableLabel) return null;

    if (!this.isModelLoaded) {
      await this.loadModel();
    }

    if (!this.isModelLoaded || this.isGenerating) {
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
      return this._isUsableGeneration(generated) ? generated : null;
    } catch (error) {
      logError('RootFactsService.generateFacts', error);
      return null;
    }
  }

  async _generateFact(vegetableLabel, tone) {
    const messages = buildFunFactPrompt(vegetableLabel, tone);
    return this.textClient.generate(messages, getGenerationConfig(tone));
  }

  /**
   * Cheap guard against obviously broken output (empty, or a runaway wall of
   * repeated text) from a small model. This is not a fact-checker - factual
   * plausibility is asked for in the prompt, not verified after the fact.
   */
  _isUsableGeneration(text) {
    return typeof text === 'string' && text.trim().length > 0 && text.length < MAX_GENERATION_LENGTH;
  }

  /** Releases the loaded model's resources, if any. */
  async dispose() {
    await this.textClient?.dispose();
    this.isModelLoaded = false;
  }
}

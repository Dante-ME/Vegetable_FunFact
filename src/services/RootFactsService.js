import { TextGenerationClient } from './TextGenerationClient.js';
import { FactsRepository } from './FactsRepository.js';
import { buildToneRewritePrompt } from '../utils/promptBuilder.js';
import { logError, withTimeout } from '../utils/common.js';
import {
  getActiveTextModelConfig,
  BACKEND_PREFERENCE,
  GENERATION_DEFAULTS,
  GENERATION_TIMEOUT_MS,
  DEFAULT_TONE,
  isValidTone,
} from '../config/textModel.config.js';

/** Maximum character length a rewrite is allowed before it's treated as unusable. */
const MAX_REWRITE_LENGTH = 400;

/**
 * Turns a detected vegetable label into the fact shown to the user.
 *
 * The local knowledge base (FactsRepository) is always the source of truth
 * for WHAT is said - the language model (TextGenerationClient) only ever
 * restyles HOW it is said, for the currently selected tone. If the model
 * isn't loaded, times out, or returns something unusable, this service
 * falls back to the verified fact exactly as written: the user never sees
 * an invented claim, and never sees an error state instead of a fact.
 *
 * Which model is used is entirely controlled by config/textModel.config.js -
 * this class never references a specific model id, so swapping models is a
 * one-line config change, not a code change.
 */
export class RootFactsService {
  constructor() {
    this.factsRepository = new FactsRepository();
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
   * logged here so the app keeps working from the knowledge base alone,
   * but isModelLoaded simply stays false, so the *next* call to loadModel()
   * (e.g. after the next successful detection) retries from scratch - a
   * transient failure never permanently disables tone rewriting.
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

  /** Sets the tone used for future rewrites; falls back to the default on an unknown value. */
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
   * Returns the fact to display for `vegetableLabel`, rewritten in the
   * current tone when possible.
   *
   * @param {string} vegetableLabel - a label as produced by DetectionService,
   *   expected to match one of the keys in src/data/facts.json.
   * @returns {Promise<string|null>} the fact text, or null only if the label
   *   has no entry in the knowledge base at all.
   */
  async generateFacts(vegetableLabel) {
    const verifiedFact = this.factsRepository.getFact(vegetableLabel);

    if (!verifiedFact) {
      logError(
        'RootFactsService.generateFacts',
        new Error(`No verified fact found for label "${vegetableLabel}".`),
      );
      return null;
    }

    if (!this.isModelLoaded || this.isGenerating) {
      return verifiedFact;
    }

    this.isGenerating = true;
    const generationPromise = this._rewriteTone(verifiedFact, this.currentTone);

    // Transformers.js gives no way to cancel an in-flight pipeline call, so
    // withTimeout() below only stops *this method* from waiting on it - the
    // real call keeps running in the background. isGenerating is therefore
    // released here, tied to generationPromise itself settling, instead of
    // in a `finally` on the timeout race: if the timeout wins, the flag
    // stays true for as long as the real call is still running, so any
    // generateFacts() call made in that window safely falls back to the
    // verified fact instead of starting a second invocation against the
    // same pipeline instance. Only once the real call finishes does the
    // next call get to actually use the pipeline again.
    generationPromise.catch(() => {}).finally(() => {
      this.isGenerating = false;
    });

    try {
      const rewritten = await withTimeout(generationPromise, GENERATION_TIMEOUT_MS);
      return this._isUsableRewrite(rewritten) ? rewritten : verifiedFact;
    } catch (error) {
      logError('RootFactsService.generateFacts', error);
      return verifiedFact;
    }
  }

  async _rewriteTone(originalFact, tone) {
    const messages = buildToneRewritePrompt(originalFact, tone);
    return this.textClient.generate(messages, GENERATION_DEFAULTS);
  }

  /**
   * Cheap guard against obviously broken output (empty, or a runaway wall of
   * repeated text) from a small model. This is not a fact-checker - the
   * model is never trusted for correctness, only for a plausible rewrite.
   */
  _isUsableRewrite(text) {
    return typeof text === 'string' && text.trim().length > 0 && text.length < MAX_REWRITE_LENGTH;
  }

  /** Releases the loaded model's resources, if any. */
  async dispose() {
    await this.textClient?.dispose();
    this.isModelLoaded = false;
  }
}

import { TextGenerationClient } from './TextGenerationClient.js';
import { buildFunFactPrompt } from '../utils/promptBuilder.js';
import { logError, withTimeout } from '../utils/common.js';
import {
  TEXT_MODEL_ID,
  TEXT_MODEL_TASK,
  TEXT_MODEL_DTYPE_BY_BACKEND,
  TEXT_MODEL_BACKEND_PREFERENCE,
  GENERATION_DEFAULTS,
  GENERATION_TIMEOUT_MS,
  MODEL_LOAD_TIMEOUT_MS,
  DEFAULT_TONE,
  isValidTone,
} from '../config/textModel.config.js';

/** Maximum character length a generation is allowed before it's treated as unusable. */
const MAX_GENERATION_LENGTH = 400;

/**
 * Words/phrases that mean the model drifted out of "state one fact" mode:
 * chat-role labels leaking out of the instruction prompt ("assistant",
 * "system", "user"), a conversational opener ("hello", "sure") or the model
 * talking about itself ("as an ai"). Any of these makes the output unusable
 * regardless of the rest of the sentence.
 *
 * Matched on word boundaries, not as bare substrings, so ordinary words
 * that merely contain one of these (e.g. "measure", "pressure") are not
 * rejected - the check targets the actual word.
 */
const REJECTED_PATTERN = /\b(assistant|system|user|hello|sure|as an ai)\b/i;

/**
 * Backstop for the category confabulation this model is prone to - putting
 * the vegetable in the wrong kingdom entirely ("Carrots are a popular
 * animal", "Cabbage is a popular video game"). promptBuilder.js pins the
 * category positively, which is the primary fix; this only catches what
 * slips through.
 *
 * Deliberately a short list of category words, not a topic filter. It can
 * only ever reject wholesale, so every entry added is a legitimate fact it
 * might also throw away ("...unlike fish, spinach..."), and a long list
 * would reject more good output than bad. `games?` covers "video game"
 * on its own.
 */
const WRONG_CATEGORY_PATTERN = /\b(animals?|dogs?|cats?|birds?|fish|games?)\b/i;

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
   * Bounded by MODEL_LOAD_TIMEOUT_MS, but ONLY on the caller's side of the
   * await. This distinction is the whole design of this method, and getting
   * it wrong caused a real bug once: the timeout used to wrap the promise
   * stored in _loadModelPromise, so when a load ran long, the race settled
   * and _loadModelPromise/isModelLoaded reset to "not loaded" while the real
   * pipeline() call kept running unseen in the background. The next
   * detection then saw no load in flight and started a SECOND
   * TextGenerationClient/pipeline() call, competing with the first for
   * bandwidth and CPU (and leaking the first one's ONNX session, never
   * disposed) - visible in practice as _loadModelInternal's call count
   * climbing past 1 and the model never finishing a clean download into
   * transformers.js's cache.
   *
   * So _loadModelPromise still tracks the REAL load promise end to end and
   * is cleared only when that real load settles; withTimeout() is applied to
   * a separate race that merely stops THIS call from waiting any longer.
   * A timed-out caller therefore gives up while the download keeps going,
   * and the next caller re-joins that same in-flight load instead of
   * starting a competing one - so a slow network costs the user one error
   * state, not a restarted download.
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

    if (!this._loadModelPromise) {
      this._loadModelPromise = this._loadModelInternal().finally(() => {
        this._loadModelPromise = null;
      });
    }

    // Raced, but never assigned back to _loadModelPromise (see above), so a
    // timeout here abandons the wait without abandoning the load. Caught
    // rather than rethrown to keep loadModel()'s existing contract: it
    // never throws, it just leaves isModelLoaded false for the caller to
    // check - which generateFacts() already does on the next line.
    try {
      await withTimeout(this._loadModelPromise, MODEL_LOAD_TIMEOUT_MS);
    } catch (error) {
      logError('RootFactsService.loadModel', error);
    }
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
      const usable = this._isUsableGeneration(generated, vegetableLabel);
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
    const prompt = buildFunFactPrompt(vegetableLabel, tone);
    console.log(`[PERF] Prompt build: ${(performance.now() - promptBuildStart).toFixed(1)} ms`);

    console.log('[DEBUG 3] Full instruction prompt sent to TextGenerationClient:', JSON.stringify(prompt));
    const result = await this.textClient.generate(prompt, GENERATION_DEFAULTS);
    console.log('[DEBUG 6] Final extracted text returned by TextGenerationClient:', JSON.stringify(result));
    return result;
  }

  /**
   * Cheap guard against obviously broken or off-task output from a small
   * model. This is not a fact-checker or a rewriter - it only accepts or
   * rejects the text wholesale, never edits it.
   *
   * Four checks, cheapest first:
   *  1. empty / runaway wall of repeated text,
   *  2. cut off mid-thought - no sentence-ending punctuation, which catches
   *     generations that hit max_new_tokens before reaching a natural stop,
   *  3. chat-role leakage or conversational filler (REJECTED_PATTERN),
   *  4. the vegetable placed in the wrong category entirely - an animal, a
   *     game (WRONG_CATEGORY_PATTERN),
   *  5. the answer must actually be ABOUT the detected vegetable, i.e. it
   *     has to mention it by name. A small model asked about "Carrot" can
   *     happily produce a fact about something else entirely, and that is
   *     invisible to every other check here.
   *
   * A rejected generation is treated the same as any other generation
   * failure: generateFacts() returns null and the caller shows its error
   * state, rather than displaying broken or off-topic text.
   */
  _isUsableGeneration(text, vegetableLabel) {
    if (typeof text !== 'string') return false;

    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length >= MAX_GENERATION_LENGTH) return false;

    if (!/[.!?]$/.test(trimmed)) return false;

    if (REJECTED_PATTERN.test(trimmed)) return false;

    if (WRONG_CATEGORY_PATTERN.test(trimmed)) return false;

    return this._mentionsVegetable(trimmed, vegetableLabel);
  }

  /**
   * True if `text` names `vegetableLabel`. Compared lowercased, with a
   * single trailing "s" stripped off the label, so a plural answer still
   * counts ("Peas" -> "pea", which matches "Peas are..." and "a pea pod").
   * An empty/missing label can't be checked, so it isn't treated as a
   * failure here - generateFacts() already rejects those before generating.
   */
  _mentionsVegetable(text, vegetableLabel) {
    const label = String(vegetableLabel ?? '').trim().toLowerCase();
    if (label.length === 0) return true;

    return text.toLowerCase().includes(label.replace(/s$/, ''));
  }

  /** Releases the loaded model's resources, if any. */
  async dispose() {
    await this.textClient?.dispose();
    this.isModelLoaded = false;
  }
}

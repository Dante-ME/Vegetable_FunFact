import { filterSupportedBackends, selectFirstWorkingBackend } from '../utils/common.js';

/**
 * Thin wrapper around a single Transformers.js text-generation pipeline
 * (a decoder-only, chat-formatted instruct model - see
 * config/textModel.config.js for which one).
 *
 * This is the only file in the codebase that uses `@huggingface/transformers`.
 * RootFactsService talks to this class through a small, model-agnostic
 * interface (load/generate/dispose) and never touches the pipeline object
 * directly.
 *
 * The library itself is dynamically imported inside load() rather than
 * imported at the top of this file, so the bundler splits it into its own
 * chunk that's only fetched once a generation is actually about to run,
 * not bundled into the app's initial JS payload.
 */
export class TextGenerationClient {
  /**
   * @param {object} options
   * @param {string} options.modelId - Hugging Face repo id of the model.
   * @param {string} options.task - Transformers.js pipeline task name.
   * @param {Object<string, string>} options.dtypeByBackend - Quantization/
   *   precision variant to request per device (e.g. { webgpu: 'q4f16',
   *   wasm: 'q4' }), so each candidate is attempted with the dtype that
   *   actually suits it instead of one dtype for every device.
   * @param {string[]} options.backendPreference - Devices to try, in order.
   *   The first one that loads successfully wins.
   * @param {string} options.modelHost - Base URL the model files are served
   *   from (trailing slash included). Same-origin paths like '/models/' are
   *   valid here too.
   * @param {string} options.pathTemplate - Path appended to `modelHost` to
   *   locate a model directory, with '{model}' substituted.
   */
  constructor({ modelId, task, dtypeByBackend, backendPreference, modelHost, pathTemplate }) {
    this.modelId = modelId;
    this.task = task;
    this.dtypeByBackend = dtypeByBackend;
    this.backendPreference = backendPreference;
    this.modelHost = modelHost;
    this.pathTemplate = pathTemplate;

    this.pipelineInstance = null;
    this.resolvedDevice = null;

    // [PERF] Identifies this specific pipeline object across log lines, so
    // repeated generate() calls can be proven to reuse the same instance
    // instead of a new one being created per call.
    this._pipelineInstanceId = null;
  }

  isLoaded() {
    return this.pipelineInstance !== null;
  }

  /**
   * Loads the model, trying each backend in `backendPreference` in order
   * until one succeeds. WebGPU is skipped up front on browsers that don't
   * expose the API at all, rather than waiting for it to fail.
   */
  async load() {
    if (this.pipelineInstance) return this.pipelineInstance;

    const loadStart = performance.now();

    const { pipeline, env } = await import('@huggingface/transformers');

    // Point transformers.js at our own static host instead of the Hugging
    // Face Hub. These are the library's supported hooks for this - a full
    // URL cannot be passed as the model id, because hub.js validates the id
    // with isValidHfModelId() and throws before requesting anything.
    //
    // allowRemoteModels stays true because "remote" here just means "over
    // HTTP via remoteHost", which is how same-origin '/models/' is served
    // too. allowLocalModels is pinned false (already the browser default)
    // so there is exactly ONE resolution path in every environment: no
    // filesystem probe, no silent second attempt, and - since remoteHost no
    // longer points at Hugging Face - no way for a missing file to quietly
    // fall back to downloading from the Hub. A missing file is a 404 that
    // surfaces as a load failure, which is the intended no-fallback
    // behavior.
    env.remoteHost = this.modelHost;
    env.remotePathTemplate = this.pathTemplate;
    env.allowRemoteModels = true;
    env.allowLocalModels = false;

    console.log(`[PERF] Model host in use: ${env.remoteHost}${env.remotePathTemplate.replace('{model}', this.modelId)}`);

    const candidates = filterSupportedBackends(this.backendPreference);

    this.resolvedDevice = await selectFirstWorkingBackend(candidates, async (device) => {
      const pipelineCallStart = performance.now();
      // [PERF] Transformers.js reports download progress via this callback.
      // The timestamp of the LAST progress event is used below as the
      // dividing line between "download" and "init" - everything after the
      // last file finishes fetching but before pipeline() resolves is
      // tokenizer/model/ONNX-session construction, not network time.
      let lastProgressTime = pipelineCallStart;

      this.pipelineInstance = await pipeline(this.task, this.modelId, {
        dtype: this.dtypeByBackend[device],
        device,
        progress_callback: () => {
          lastProgressTime = performance.now();
        },
      });

      const pipelineCallEnd = performance.now();
      this._pipelineInstanceId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      console.log(`[PERF] Model load (download, approx from progress events): ${(lastProgressTime - pipelineCallStart).toFixed(1)} ms`);
      console.log(`[PERF] Pipeline init (tokenizer/model/session setup, approx): ${(pipelineCallEnd - lastProgressTime).toFixed(1)} ms`);
      console.log(`[PERF] pipeline() call total (device: ${device}): ${(pipelineCallEnd - pipelineCallStart).toFixed(1)} ms`);
      console.log(`[PERF] Pipeline instance id (created): ${this._pipelineInstanceId}`);
    });

    const loadEnd = performance.now();
    console.log(`[PERF] load() total (incl. backend fallback attempts, if any): ${(loadEnd - loadStart).toFixed(1)} ms`);

    return this.pipelineInstance;
  }

  /**
   * Runs the loaded pipeline on a chat-formatted `messages` array and
   * returns only the generated reply as a plain string.
   */
  async generate(messages, generationOptions) {
    if (!this.pipelineInstance) {
      throw new Error('TextGenerationClient: generate() called before load().');
    }

    // [PERF] Proves the same pipeline object is reused across calls instead
    // of a new one being created per generation - the id is only assigned
    // once, inside load(), so an unchanged id across multiple generate()
    // calls is direct proof of reuse (not an inference from behavior).
    console.log(`[PERF] Pipeline instance id (used for this generation): ${this._pipelineInstanceId}`);

    console.log('[DEBUG 4] Messages object handed directly to the transformers.js pipeline call:', JSON.stringify(messages, null, 2));

    const genStart = performance.now();
    const output = await this.pipelineInstance(messages, generationOptions);
    const genEnd = performance.now();
    console.log(`[PERF] Model generation (await generator(...) only): ${(genEnd - genStart).toFixed(1)} ms`);

    console.log('[DEBUG 5] Raw output from transformers.js pipeline, before any parsing:', JSON.stringify(output, null, 2));

    const extractStart = performance.now();
    const text = this._extractGeneratedText(output);
    const extractEnd = performance.now();
    console.log(`[PERF] Post process - extraction (parsing raw output): ${(extractEnd - extractStart).toFixed(1)} ms`);

    return text;
  }

  /**
   * transformers.js text-generation pipelines return an array whose
   * `generated_text` is either a plain string, or (for chat-formatted
   * input, as used here) the full conversation array - the model's reply
   * is the last entry in that array.
   */
  _extractGeneratedText(output) {
    const result = Array.isArray(output) ? output[0] : output;
    const generatedText = result?.generated_text;
    console.log('[DEBUG 6a] result.generated_text field shape (array = chat turns, string = plain):', generatedText);

    if (Array.isArray(generatedText)) {
      const lastTurn = generatedText[generatedText.length - 1];
      console.log('[DEBUG 6b] Last chat turn extracted (should be role: assistant):', lastTurn);
      return (lastTurn?.content ?? '').trim();
    }

    return typeof generatedText === 'string' ? generatedText.trim() : '';
  }

  /** Releases the underlying ONNX Runtime session, if the pipeline exposes one. */
  async dispose() {
    if (typeof this.pipelineInstance?.dispose === 'function') {
      await this.pipelineInstance.dispose();
    }
    this.pipelineInstance = null;
    this.resolvedDevice = null;
  }
}

import { filterSupportedBackends, selectFirstWorkingBackend } from '../utils/common.js';

/**
 * Thin wrapper around a single Transformers.js text-generation pipeline
 * (a seq2seq instruction model driven by a plain instruction string - see
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
   */
  constructor({ modelId, task, dtypeByBackend, backendPreference }) {
    this.modelId = modelId;
    this.task = task;
    this.dtypeByBackend = dtypeByBackend;
    this.backendPreference = backendPreference;

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

    // No env.remoteHost / env.remotePathTemplate override: the model is a
    // Hugging Face repo id and is resolved against the Hub exactly the way
    // transformers.js resolves one by default, i.e.
    //   <remoteHost><model>/resolve/<revision>/<file>
    // Nothing in this project rewrites that any more.
    console.log(`[PERF] Model source in use: ${env.remoteHost}${env.remotePathTemplate.replace('{model}', this.modelId)}`);

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
   * Runs the loaded pipeline on a plain instruction string and returns the
   * generated answer as a plain string.
   */
  async generate(prompt, generationOptions) {
    if (!this.pipelineInstance) {
      throw new Error('TextGenerationClient: generate() called before load().');
    }

    // [PERF] Proves the same pipeline object is reused across calls instead
    // of a new one being created per generation - the id is only assigned
    // once, inside load(), so an unchanged id across multiple generate()
    // calls is direct proof of reuse (not an inference from behavior).
    console.log(`[PERF] Pipeline instance id (used for this generation): ${this._pipelineInstanceId}`);

    console.log('[DEBUG 4] Instruction string handed directly to the transformers.js pipeline call:', JSON.stringify(prompt));

    const genStart = performance.now();
    const output = await this.pipelineInstance(prompt, generationOptions);
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
   * transformers.js text2text-generation pipelines return an array whose
   * `generated_text` is a plain string holding only the decoder's answer -
   * unlike decoder-only text-generation, the prompt is NOT echoed back, so
   * nothing has to be stripped off the front here.
   *
   * The array branch is kept as a defensive fallback for a chat-shaped
   * return value, so this stays correct if the configured model/task is
   * ever switched back.
   */
  _extractGeneratedText(output) {
    const result = Array.isArray(output) ? output[0] : output;
    const generatedText = result?.generated_text;
    console.log('[DEBUG 6a] result.generated_text field shape (string = plain, array = chat turns):', generatedText);

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

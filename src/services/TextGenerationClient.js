import { pipeline } from '@huggingface/transformers';
import { isWebGPUSupported } from '../utils/common.js';

/**
 * Thin wrapper around a single Transformers.js pipeline.
 *
 * This is the only file in the codebase that imports `@huggingface/transformers`
 * directly. Everything else (RootFactsService included) talks to this class
 * through a small, model-agnostic interface (load/generate/dispose), so
 * swapping the underlying model or runtime never touches business logic.
 */
export class TextGenerationClient {
  /**
   * @param {object} options
   * @param {string} options.modelId - Hugging Face repo id of the model.
   * @param {string} options.task - Transformers.js pipeline task name.
   * @param {string} options.dtype - Quantization/precision variant to load.
   * @param {string[]} options.backendPreference - Devices to try, in order
   *   (e.g. ['webgpu', 'wasm']). The first one that loads successfully wins.
   */
  constructor({ modelId, task, dtype, backendPreference }) {
    this.modelId = modelId;
    this.task = task;
    this.dtype = dtype;
    this.backendPreference = backendPreference;

    this.pipelineInstance = null;
    this.resolvedDevice = null;
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

    const candidates = this.backendPreference.filter(
      (device) => device !== 'webgpu' || isWebGPUSupported(),
    );

    let lastError = new Error(
      `TextGenerationClient: no usable backend in [${this.backendPreference.join(', ')}].`,
    );

    for (const device of candidates) {
      try {
        this.pipelineInstance = await pipeline(this.task, this.modelId, {
          dtype: this.dtype,
          device,
        });
        this.resolvedDevice = device;
        return this.pipelineInstance;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  /**
   * Runs the loaded pipeline on a chat-formatted `messages` array and
   * returns only the generated reply as a plain string.
   */
  async generate(messages, generationOptions) {
    if (!this.pipelineInstance) {
      throw new Error('TextGenerationClient: generate() called before load().');
    }

    const output = await this.pipelineInstance(messages, generationOptions);
    return this._extractGeneratedText(output);
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

    if (Array.isArray(generatedText)) {
      const lastTurn = generatedText[generatedText.length - 1];
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

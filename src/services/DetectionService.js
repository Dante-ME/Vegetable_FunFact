import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import { isWebGPUSupported, validateModelMetadata, logError } from '../utils/common.js';
import { APP_CONFIG } from '../utils/config.js';
import {
  DETECTION_MODEL_CONFIG,
  BACKEND_PREFERENCE,
  DEFAULT_IMAGE_SIZE,
} from '../config/detectionModel.config.js';

/**
 * Loads the Teachable Machine vegetable classifier and runs inference on
 * camera frames. The model is kept as a singleton on the instance -
 * loadModel() is a no-op if a model is already loaded, so it is always safe
 * to call defensively.
 *
 * Every tensor created during a prediction is scoped inside tf.tidy(), so a
 * single call never leaks GPU/CPU memory no matter how often it runs inside
 * a detection loop.
 */
export class DetectionService {
  constructor() {
    this.model = null;
    this.labels = [];
    this.imageSize = DEFAULT_IMAGE_SIZE;
    this.resolvedBackend = null;
  }

  isLoaded() {
    return this.model !== null;
  }

  /** Which TensorFlow.js backend ended up being used ('webgpu' | 'webgl' | 'cpu' | null). */
  getActiveBackend() {
    return this.resolvedBackend;
  }

  /**
   * Loads the classifier and its label metadata. Picks the best available
   * backend first (WebGPU, automatically falling back to WebGL then CPU if
   * unavailable or if loading fails), then loads the model and metadata
   * concurrently.
   *
   * Unlike RootFactsService, there is no fallback path for a failed
   * classifier load - detection is the app's core function, so this
   * re-throws after logging and resetting state, letting the caller decide
   * how to surface the failure to the user.
   */
  async loadModel() {
    if (this.isLoaded()) return;

    try {
      await this._setAdaptiveBackend();

      const [model, metadata] = await Promise.all([
        tf.loadLayersModel(DETECTION_MODEL_CONFIG.modelUrl),
        fetch(DETECTION_MODEL_CONFIG.metadataUrl).then((response) => response.json()),
      ]);

      if (!validateModelMetadata(metadata)) {
        throw new Error('DetectionService: metadata.json is missing a valid "labels" array.');
      }

      this.model = model;
      this.labels = metadata.labels;
      this.imageSize = metadata.imageSize ?? DEFAULT_IMAGE_SIZE;
    } catch (error) {
      logError('DetectionService.loadModel', error);
      this.model = null;
      this.labels = [];
      throw error;
    }
  }

  /**
   * Runs the classifier on a single frame and returns the app-wide
   * detection result shape: { className, confidence, isValid }.
   *
   * `confidence` is a 0-100 percentage (matching APP_CONFIG.detectionConfidenceThreshold
   * in utils/config.js) and `isValid` is true once it meets that threshold -
   * this is the single consistent shape used everywhere a detection result
   * is passed around, replacing the earlier score/confidence/isValid mismatch.
   *
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} imageElement
   */
  async predict(imageElement) {
    if (!this.isLoaded()) {
      throw new Error('DetectionService: predict() called before loadModel() completed.');
    }

    try {
      const scores = tf.tidy(() => {
        const input = this._preprocess(imageElement);
        const output = this.model.predict(input);
        return output.dataSync();
      });

      return this._toDetectionResult(scores);
    } catch (error) {
      logError('DetectionService.predict', error);
      throw error;
    }
  }

  /** Resizes and normalizes a raw frame to match what the model was trained on. */
  _preprocess(imageElement) {
    // Teachable Machine's standard preprocessing maps 0-255 RGB into [-1, 1].
    return tf.browser
      .fromPixels(imageElement)
      .resizeBilinear([this.imageSize, this.imageSize])
      .toFloat()
      .div(127.5)
      .sub(1)
      .expandDims(0);
  }

  /** Converts raw softmax scores into the app-wide detection result shape. */
  _toDetectionResult(scores) {
    const scoresArray = Array.from(scores);
    const bestIndex = scoresArray.indexOf(Math.max(...scoresArray));
    const confidence = Math.round(scoresArray[bestIndex] * 10000) / 100; // 0-100, 2 decimals

    return {
      className: this.labels[bestIndex],
      confidence,
      isValid: confidence >= APP_CONFIG.detectionConfidenceThreshold,
    };
  }

  /**
   * Tries each backend in BACKEND_PREFERENCE in order, skipping WebGPU up
   * front on browsers that don't expose the API at all, and falling
   * through to the next candidate if a backend fails to initialize.
   * Mirrors the same fallback strategy TextGenerationClient uses for the
   * text model, so backend-adaptive logic reads the same way everywhere.
   */
  async _setAdaptiveBackend() {
    const candidates = BACKEND_PREFERENCE.filter(
      (backend) => backend !== 'webgpu' || isWebGPUSupported(),
    );

    let lastError = new Error(
      `DetectionService: no usable backend in [${BACKEND_PREFERENCE.join(', ')}].`,
    );

    for (const backend of candidates) {
      try {
        await tf.setBackend(backend);
        await tf.ready();
        this.resolvedBackend = backend;
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  /** Releases the model from memory. Safe to call even if never loaded. */
  dispose() {
    this.model?.dispose();
    this.model = null;
    this.labels = [];
    this.resolvedBackend = null;
  }
}

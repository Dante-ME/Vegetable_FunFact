/**
 * Configuration for the on-device vegetable classifier (TensorFlow.js).
 *
 * Keeping these values here instead of inline in DetectionService means the
 * model location or backend strategy can change without touching business
 * logic - mirroring config/textModel.config.js, which does the same thing
 * for the tone-rewrite model.
 */

/** Where the exported Teachable Machine model lives, served from /public. */
export const DETECTION_MODEL_CONFIG = {
  modelUrl: '/model/model.json',
  metadataUrl: '/model/metadata.json',
};

/** Backend order to attempt when loading the model, best first. */
export const BACKEND_PREFERENCE = ['webgpu', 'webgl', 'cpu'];

/** Used only if metadata.json doesn't specify an imageSize. */
export const DEFAULT_IMAGE_SIZE = 224;

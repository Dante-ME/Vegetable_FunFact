export const logError = (context, error) => {
  console.error(`❌ ${context}:`, error);
};

export const isWebGPUSupported = () => {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
};

export const isMobileDevice = () => {
  return navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

export const createDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Races `promise` against a timer and rejects if it hasn't settled after
 * `ms` milliseconds. Note this does not cancel the original operation (the
 * pipeline call keeps running in the background) - it only stops the caller
 * from waiting on it, so a slow model call can't block the UI forever.
 */
export const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Operation timed out after ${ms}ms`)),
      ms,
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export const validateModelMetadata = (metadata) => {
  return metadata && metadata.labels && Array.isArray(metadata.labels);
};

/**
 * Removes 'webgpu' from a backend/device candidate list on browsers that
 * don't expose the API at all, so it's never attempted (and never counted
 * as a failure) instead of just waiting for it to fail.
 */
export const filterSupportedBackends = (candidates) =>
  candidates.filter((candidate) => candidate !== 'webgpu' || isWebGPUSupported());

/**
 * Shared "prefer WebGPU, fall back automatically" algorithm used by both
 * DetectionService (TensorFlow.js backends) and TextGenerationClient
 * (Transformers.js devices) - the two services attempt different things per
 * candidate, but the try-in-order-until-one-works logic itself is identical,
 * so it lives here once instead of being duplicated in both services.
 *
 * @param {string[]} candidates - ordered list of backend/device names to try.
 * @param {(candidate: string) => Promise<void>} attempt - performs the
 *   actual backend switch/load; should throw if the candidate doesn't work.
 * @returns {Promise<string>} the first candidate for which `attempt` succeeded.
 */
export const selectFirstWorkingBackend = async (candidates, attempt) => {
  let lastError = new Error(`No usable backend in [${candidates.join(', ')}].`);

  for (const candidate of candidates) {
    try {
      await attempt(candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

export const getCameraErrorMessage = (error) => {
  const errorMessages = {
    'NotAllowedError': 'Izin kamera ditolak. Harap izinkan akses kamera.',
    'NotFoundError': 'Tidak ada kamera ditemukan pada perangkat ini.',
    'NotReadableError': 'Kamera sedang digunakan oleh aplikasi lain.'
  };

  return errorMessages[error.name] || 'Gagal memulai kamera';
};

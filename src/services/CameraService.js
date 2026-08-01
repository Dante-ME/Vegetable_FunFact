import { getCameraErrorMessage, logError } from '../utils/common.js';

/** Camera selection keywords used by CameraSection's camera-select control. */
export const CAMERA_TYPE = {
  DEFAULT: 'default', // rear/environment-facing camera
  FRONT: 'front', // front/user-facing camera
};

const FACING_MODE_BY_CAMERA_TYPE = {
  [CAMERA_TYPE.DEFAULT]: 'environment',
  [CAMERA_TYPE.FRONT]: 'user',
};

/**
 * Owns the camera lifecycle: enumerating devices, starting/stopping a
 * MediaStream, and keeping the <video> element it was given in sync with
 * that stream. This service only manages hardware access - it never runs
 * detection logic itself.
 */
export class CameraService {
  constructor() {
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.fps = null;
    this.activeCameraType = CAMERA_TYPE.DEFAULT;

    // Internal bookkeeping to prevent duplicated streams / resource leaks
    // when startCamera()/stopCamera() are called in quick succession (see
    // startCamera() and _startCameraInternal() for how these are used).
    this._startPromise = null;
    this._stopRequested = false;
  }

  setVideoElement(videoElement) {
    this.video = videoElement;
  }

  setCanvasElement(canvasElement) {
    this.canvas = canvasElement;
  }

  /**
   * Lists available video input devices. Device labels are only populated
   * by the browser once camera permission has been granted at least once -
   * before that, entries still have usable deviceIds but blank labels.
   */
  async loadCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput');
  }

  /**
   * Starts the camera stream and attaches it to the configured <video>
   * element. Any existing stream is stopped first, so calling this
   * repeatedly (e.g. when switching cameras) never leaves duplicate streams
   * running. Concurrent calls are deduplicated - a second call made while
   * one is still in flight reuses the same in-progress start instead of
   * racing it.
   *
   * @param {string} [cameraSelector] - a CAMERA_TYPE value ('default' |
   *   'front') or a specific deviceId from loadCameras(). Defaults to the
   *   rear/default camera.
   */
  async startCamera(cameraSelector = CAMERA_TYPE.DEFAULT) {
    if (this._startPromise) {
      return this._startPromise;
    }

    this._startPromise = this._startCameraInternal(cameraSelector).finally(() => {
      this._startPromise = null;
    });

    return this._startPromise;
  }

  async _startCameraInternal(cameraSelector) {
    if (!this.video) {
      throw new Error('CameraService: call setVideoElement() before startCamera().');
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Kamera tidak didukung oleh browser ini.');
    }

    this.stopCamera();
    this._stopRequested = false;

    try {
      const constraints = this._buildConstraints(cameraSelector);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (this._stopRequested) {
        // stopCamera() was called while we were waiting on the permission
        // prompt - discard this stream instead of leaking it.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      this.activeCameraType = cameraSelector;
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (error) {
      this.stream = null;
      throw new Error(getCameraErrorMessage(error));
    }
  }

  /** Stops all tracks on the current stream and detaches it from the video element. */
  stopCamera() {
    this._stopRequested = true;

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.video) {
      this.video.srcObject = null;
    }
  }

  /**
   * Sets the desired frame rate. Applied immediately to the live track if
   * the camera is already running; otherwise it's used the next time
   * startCamera() is called.
   */
  async setFPS(fps) {
    this.fps = fps;

    const [track] = this.stream?.getVideoTracks() ?? [];
    if (!track) return;

    try {
      await track.applyConstraints({ frameRate: { ideal: fps } });
    } catch (error) {
      logError('CameraService.setFPS', error);
    }
  }

  /** True if a live camera stream is currently running. */
  isActive() {
    return Boolean(this.stream) && this.stream.getVideoTracks().some((track) => track.readyState === 'live');
  }

  /** True if the video element is attached and has enough data to read frames from. */
  isReady() {
    return Boolean(this.video) && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }

  /**
   * Builds the getUserMedia video constraints for a given camera selection.
   * A CAMERA_TYPE value maps to a `facingMode` constraint, which works
   * across devices without needing a specific deviceId. Any other string is
   * treated as an exact deviceId, for picking a specific enumerated camera.
   */
  _buildConstraints(cameraSelector) {
    const isKnownCameraType = Object.prototype.hasOwnProperty.call(
      FACING_MODE_BY_CAMERA_TYPE,
      cameraSelector,
    );

    const video = isKnownCameraType
      ? { facingMode: FACING_MODE_BY_CAMERA_TYPE[cameraSelector] }
      : { deviceId: { exact: cameraSelector } };

    if (this.fps) {
      video.frameRate = { ideal: this.fps };
    }

    return { video, audio: false };
  }
}

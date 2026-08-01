import { useState, useRef, useEffect } from 'react';
import { Camera, Mic, ScanLine } from 'lucide-react';
import { TONE_CONFIG } from '../utils/config';

function CameraSection({
  isRunning,
  onToggleCamera,
  onToneChange,
  services,
  modelStatus,
  error,
  currentTone
}) {
  const [fps, setFps] = useState(30);
  const [cameraType, setCameraType] = useState('default');
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // services.camera is only ever set once (App.jsx creates it on mount and
  // never replaces it), so this only needs to run when that first becomes
  // available - not on every render.
  useEffect(() => {
    if (services.camera) {
      if (videoRef.current && !services.camera.video) {
        services.camera.setVideoElement(videoRef.current);
      }
      if (canvasRef.current && !services.camera.canvas) {
        services.camera.setCanvasElement(canvasRef.current);
      }
    }
  }, [services.camera]);

  useEffect(() => {
    if (services.camera) {
      services.camera.setFPS(fps);
    }
  }, [fps, services.camera]);

  const handleCameraChange = (newCameraType) => {
    // Only updates local selection - the dropdown is disabled while running
    // (see below), and actually starting the camera is App.jsx's job via
    // onToggleCamera, so there is nothing else to do here.
    setCameraType(newCameraType);
  };

  const handleFpsChange = (newFps) => {
    setFps(Number(newFps));
  };

  const handleToneChange = (e) => {
    const newTone = e.target.value;
    if (onToneChange) {
      onToneChange(newTone);
    }
  };

  const isModelReady = modelStatus === 'Model AI Siap';
  const buttonDisabled = !isModelReady;
  const buttonText = isRunning ? 'Stop Scan' : 'Mulai Scan';

  return (
    <section className="camera-section" aria-label="Camera Feed and Controls">
      <div className="camera-container">
        <div className="camera-wrapper">
          <video
            ref={videoRef}
            id="media-video"
            autoPlay
            muted
            playsInline
            className={isRunning ? '' : 'hidden'}
          />

          <canvas
            ref={canvasRef}
            id="media-canvas"
            className="hidden"
          />

          <div className={`camera-overlay ${isRunning ? 'active' : ''}`}>
            <div className="overlay-frame"></div>
          </div>

          {!isRunning && (
            <div className="camera-placeholder">
              <Camera size={48} />
              <p>Kamera tidak aktif</p>
              {error && (
                <p style={{ color: '#ef4444', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="camera-controls">
          <button
            id="btn-toggle"
            className={`capture-btn ${isRunning ? 'scanning' : ''}`}
            onClick={() => onToggleCamera(cameraType)}
            disabled={buttonDisabled}
            aria-label={buttonText}
            style={{ opacity: buttonDisabled ? 0.6 : 1 }}
          >
            <ScanLine size={24} />
          </button>
        </div>

        <div className="settings-bar">
          <div className="setting-item">
            <Camera size={16} />
            <select
              id="camera-select"
              aria-label="Pilih kamera"
              value={cameraType}
              onChange={(e) => handleCameraChange(e.target.value)}
              disabled={isRunning}
            >
              <option value="default">Belakang</option>
              <option value="front">Depan</option>
            </select>
          </div>

          <div className="setting-item fps-setting">
            <span id="fps-label">{fps} FPS</span>
            <input
              id="fps-slider"
              aria-labelledby="fps-label"
              type="range"
              min="15"
              max="60"
              step="15"
              value={fps}
              onChange={(e) => handleFpsChange(e.target.value)}
              disabled={isRunning}
            />
          </div>

          <div className="setting-item tone-setting">
            <Mic size={16} />
            <select
              id="tone-select"
              aria-label="Pilih gaya bahasa"
              value={currentTone || 'normal'}
              onChange={handleToneChange}
              disabled={isRunning}
            >
              {TONE_CONFIG.availableTones.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </section>
  );
}

export default CameraSection;

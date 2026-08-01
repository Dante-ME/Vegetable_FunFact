import { useRef, useState, useEffect } from 'react';
import Header from './components/Header';
import CameraSection from './components/CameraSection';
import InfoPanel from './components/InfoPanel';
import { useAppState } from './hooks/useAppState';
import { CameraService } from './services/CameraService';
import { DetectionService } from './services/DetectionService';
import { RootFactsService } from './services/RootFactsService';
import { APP_CONFIG } from './utils/config.js';
import { createDelay, logError } from './utils/common.js';

function App() {
  const { state, actions } = useAppState();
  const [currentTone, setCurrentTone] = useState('normal');
  const [isCopied, setIsCopied] = useState(false);

  // Loop-control flags live in refs, not reducer state: the async detection
  // loop below reads these directly so it always sees the *current* value
  // instead of one captured at the render where a tick was scheduled.
  const isRunningRef = useRef(false);
  const detectionCleanupRef = useRef(null);
  const copyFeedbackTimeoutRef = useRef(null);

  // Create the three services once and load the vision model up front - it
  // gates the scan button (see CameraSection's isModelReady check). The
  // text-generation model stays lazy, exactly as designed in Phase 1: it
  // only starts loading once the first valid detection happens, inside
  // handleValidDetection below.
  useEffect(() => {
    const cameraService = new CameraService();
    const detectionService = new DetectionService();
    const rootFactsService = new RootFactsService();

    actions.setServices({
      camera: cameraService,
      detector: detectionService,
      generator: rootFactsService,
    });

    let isMounted = true;

    detectionService
      .loadModel()
      .then(() => {
        if (isMounted) actions.setModelStatus('Model AI Siap');
      })
      .catch((error) => {
        logError('App.loadDetectionModel', error);
        if (isMounted) {
          actions.setModelStatus('Model AI gagal dimuat');
          actions.setError('Gagal memuat model AI. Muat ulang halaman untuk mencoba lagi.');
        }
      });

    // Cleanup closes over the exact instances *this* effect run created
    // (rather than reading them back from reducer state) so it can never
    // dispose the wrong generation of services, e.g. under React
    // StrictMode's dev-only mount/cleanup/mount double-invoke.
    return () => {
      isMounted = false;
      isRunningRef.current = false;
      detectionCleanupRef.current?.();
      detectionCleanupRef.current = null;
      clearTimeout(copyFeedbackTimeoutRef.current);
      cameraService.stopCamera();
      detectionService.dispose();
      rootFactsService.dispose();
    };
  }, [actions]);

  /** Stops the detection loop and the camera. Leaves any result already on screen alone. */
  function stopScanning() {
    isRunningRef.current = false;
    detectionCleanupRef.current?.();
    detectionCleanupRef.current = null;
    state.services.camera?.stopCamera();
    actions.setRunning(false);
  }

  /** Schedules the next detection tick and keeps a handle to cancel it. */
  function scheduleNextTick() {
    const timeoutId = setTimeout(runDetectionTick, APP_CONFIG.detectionRetryInterval);
    detectionCleanupRef.current = () => clearTimeout(timeoutId);
  }

  /**
   * One iteration of the detection loop. Recurses via setTimeout instead of
   * setInterval so the next tick is only ever scheduled after the current
   * prediction finishes - that alone prevents overlapping/concurrent
   * predictions, without needing a separate lock flag.
   */
  async function runDetectionTick() {
    if (!isRunningRef.current) return;

    const { camera: cameraService, detector: detectionService } = state.services;

    if (!cameraService.isReady()) {
      scheduleNextTick();
      return;
    }

    try {
      const result = await detectionService.predict(cameraService.video);
      if (!isRunningRef.current) return;

      if (result.isValid) {
        await handleValidDetection(result);
        return;
      }
    } catch (error) {
      // A single failed frame must never crash the loop - log it and keep polling.
      logError('App.runDetectionTick', error);
    }

    scheduleNextTick();
  }

  /** Runs once a confident detection is found: shows the fact, then stops scanning. */
  async function handleValidDetection(result) {
    const { generator: rootFactsService } = state.services;

    actions.setDetectionResult(result);
    actions.setAppState('analyzing');
    await createDelay(APP_CONFIG.analyzingDelay);
    if (!isRunningRef.current) return;

    actions.setFunFactData(null); // InfoPanel shows its "loading fact" state for this
    actions.setAppState('result');

    // Fire-and-forget: the tone-rewrite model loads in the background.
    // generateFacts() below already falls back to the verified fact on its
    // own whenever the model isn't ready yet, so nothing here waits on this
    // promise. Calling this on every detection (rather than only once ever)
    // is intentional and safe: RootFactsService.loadModel() no-ops once the
    // model is loaded and guards against overlapping attempts itself, so a
    // transient failure (e.g. a network blip) gets retried on the next
    // detection instead of permanently disabling tone rewriting.
    rootFactsService.loadModel().catch((error) => logError('App.loadGeneratorModel', error));

    const [fact] = await Promise.all([
      rootFactsService.generateFacts(result.className),
      createDelay(APP_CONFIG.factsGenerationDelay),
    ]);
    if (!isRunningRef.current) return;

    actions.setFunFactData(fact ?? 'error');
    stopScanning();
  }

  /** Resets any previous result, starts the camera, and kicks off the detection loop. */
  async function startScanning(cameraType) {
    if (isRunningRef.current) return;

    // Set synchronously, before the first await below, so a second call
    // arriving while this one is still waiting on camera permission sees
    // this immediately and bails at the guard above - this closes the race
    // window a button `disabled` attribute alone can't close, since React
    // hasn't re-rendered with the new state yet at that point.
    isRunningRef.current = true;

    actions.resetResults();
    setIsCopied(false);

    try {
      await state.services.camera.startCamera(cameraType);
    } catch (error) {
      isRunningRef.current = false; // roll back - the attempt failed, nothing is running
      logError('App.startScanning', error);
      actions.setError(error.message);
      return;
    }

    actions.setRunning(true);
    scheduleNextTick();
  }

  const handleToggleCamera = (cameraType) => {
    if (state.isRunning) {
      stopScanning();
      actions.resetResults();
      return;
    }

    startScanning(cameraType);
  };

  const handleToneChange = (tone) => {
    setCurrentTone(tone);
    state.services.generator?.setTone(tone);
  };

  const handleCopyFact = async () => {
    const factText = state.funFactData;
    if (!factText || factText === 'error') return;

    if (!navigator.clipboard?.writeText) {
      actions.setError('Fitur salin tidak didukung di browser ini.');
      return;
    }

    try {
      await navigator.clipboard.writeText(factText);
      setIsCopied(true);
      clearTimeout(copyFeedbackTimeoutRef.current);
      copyFeedbackTimeoutRef.current = setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      logError('App.handleCopyFact', error);
      actions.setError('Gagal menyalin fakta. Periksa izin clipboard pada browser.');
    }
  };

  return (
    <div className="app-container">
      <Header modelStatus={state.modelStatus} />

      <main className="main-content">
        <CameraSection
          isRunning={state.isRunning}
          onToggleCamera={handleToggleCamera}
          onToneChange={handleToneChange}
          services={state.services}
          modelStatus={state.modelStatus}
          error={state.error}
          currentTone={currentTone}
        />

        <InfoPanel
          appState={state.appState}
          detectionResult={state.detectionResult}
          funFactData={state.funFactData}
          error={state.error}
          onCopyFact={handleCopyFact}
          isCopied={isCopied}
        />
      </main>

      <footer className="footer">
        <p>Powered by TensorFlow.js & Transformers.js</p>
      </footer>

      {state.error && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            bottom: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: '380px',
            padding: '0.875rem 1rem',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 'var(--radius-md)',
            color: '#991b1b',
            fontSize: '0.8125rem',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            zIndex: 1000
          }}
        >
          <strong>Error:</strong> {state.error}
          <button
            onClick={() => actions.setError(null)}
            aria-label="Tutup pesan error"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              fontSize: '1.25rem',
              cursor: 'pointer',
              color: '#991b1b',
              padding: 0,
              lineHeight: 1
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export default App;

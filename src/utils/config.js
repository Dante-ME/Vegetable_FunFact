export const APP_CONFIG = {
  detectionConfidenceThreshold: 70,
  // Minimum gap (percentage points) the top prediction must have over the
  // runner-up to be trusted - a single high score can still occur on an
  // ambiguous/mixed frame, so a narrow margin over the second-best class is
  // treated as "not confident enough" even when the raw score alone clears
  // detectionConfidenceThreshold.
  detectionMinMargin: 15,
  // Number of consecutive ticks that must agree on the same class before a
  // detection is accepted - absorbs one-off unstable/transitional frames
  // (e.g. mid-pan across several vegetables) instead of acting on the first
  // frame that happens to clear the confidence/margin gates.
  detectionConsensusCount: 3,
  analyzingDelay: 2000,
  factsGenerationDelay: 2000,
  detectionRetryInterval: 100
};

export const TONE_CONFIG = {
  availableTones: [
    { value: 'normal', label: 'Normal' },
    { value: 'funny', label: 'Lucu' },
    { value: 'professional', label: 'Profesional' },
    { value: 'casual', label: 'Santai' }
  ],
  defaultTone: 'normal'
};

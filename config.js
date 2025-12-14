window.AppConfig = {
  soundModelURL: "https://teachablemachine.withgoogle.com/models/I-GA10wfZ/model.json",

  // UI / behaviour
  silenceThresholdMs: 1000,

  // VAD defaults (auto-calib ajusta)
  vad: {
    enabled: true,
    threshold: 0.020,
    minMs: 120,
    maxMs: 1200,
    ignoreAfterAsrFinalMs: 250,
    cooldownMs: 900,
    autoCalibMs: 4000,
    thresholdFloor: 0.015,
    thresholdCeil: 0.08,
    noiseMultiplier: 2.5,
    releaseFactor: 0.75
  },

  // ASR
  asr: {
    defaultLang: "en-US",
    continuous: true,
    interimResults: true
  }
};
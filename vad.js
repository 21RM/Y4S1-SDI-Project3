window.VAD = (() => {
  let mic = null;
  let amp = null;

  let enabled = window.AppConfig.vad.enabled;
  let micReady = false;
  let micState = "off"; // off | starting | on | error

  let calibrating = false;
  let calibStart = 0;
  let noiseMax = 0;

  let active = false;
  let startMs = 0;
  let lastHitMs = 0;

  function reset() {
    active = false;
    startMs = 0;
    lastHitMs = 0;
  }

  async function enableMic() {
    try {
      micState = "starting";
      micReady = false;

      const ctx = getAudioContext();
      if (ctx.state !== "running") await ctx.resume();
      userStartAudio();

      mic = new p5.AudioIn();
      mic.start(
        () => {
          amp = new p5.Amplitude();
          amp.setInput(mic);

          micReady = true;
          micState = "on";

          calibrating = true;
          calibStart = millis();
          noiseMax = 0;
        },
        () => {
          micState = "error";
          micReady = false;
        }
      );
    } catch (_) {
      micState = "error";
      micReady = false;
    }
  }

  function update(onVocalFiller) {
    if (!enabled || !amp || !micReady) return;

    const cfg = window.AppConfig.vad;
    const level = amp.getLevel();
    const now = millis();

    // auto-calibration
    if (calibrating) {
      noiseMax = Math.max(noiseMax, level);
      if (now - calibStart > cfg.autoCalibMs) {
        calibrating = false;
        cfg.threshold = Math.max(cfg.thresholdFloor, noiseMax * cfg.noiseMultiplier);
        cfg.threshold = Math.min(cfg.threshold, cfg.thresholdCeil);
        console.log("VAD calibrated:", { noiseMax, threshold: cfg.threshold });
      }
    }

    // start
    if (!active && level >= cfg.threshold) {
      if (now - lastHitMs < cfg.cooldownMs) return;
      active = true;
      startMs = now;
      return;
    }

    // end
    if (active && level < cfg.threshold * cfg.releaseFactor) {
      const dur = now - startMs;
      active = false;

      if (dur < cfg.minMs || dur > cfg.maxMs) return;

      // ignore if ASR final arrived very recently
      if (now - window.Fillers.lastAsrFinalMs < cfg.ignoreAfterAsrFinalMs) return;

      lastHitMs = now;
      const label = dur < 320 ? "vocal_filler_short" : "vocal_filler_long";
      if (typeof onVocalFiller === "function") onVocalFiller(label, `VAD ${Math.round(dur)}ms`);
    }
  }

  function getLevel() {
    return amp ? amp.getLevel() : null;
  }

  return {
    enableMic,
    update,
    reset,
    getLevel,
    toggleEnabled: () => (enabled = !enabled),

    get enabled() { return enabled; },
    get micReady() { return micReady; },
    get micState() { return micState; }
  };
})();
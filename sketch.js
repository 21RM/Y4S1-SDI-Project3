// ------------------------------
// Audio pace classifier (ml5) + VisionAssist overlays
// + Filler detector (Web Speech API -> text -> regex)
// + Interjections upgrade: expanded lexical + VAD fallback
// ------------------------------

// ML
let classifier;
let soundModelURL =
  "https://teachablemachine.withgoogle.com/models/I-GA10wfZ/model.json";

// Webcam
let video;

// Visual pulse
let pulseSpeed = 0;
let angle = 0;
let baseDiameter = 180;
let maxExpansion = 80;

// State smoothing
let currentLabel = "Background Noise";
let lastSpeechTime = 0;
let silenceThreshold = 1000; // ms

let DEBUG_FACE = false;

// ------------------------------
// FILLER DETECTOR (ASR + TEXT)
// ------------------------------

let speechRec = null;
let asrEnabled = false;
let asrStatus = "idle"; // idle | listening | error
let asrLang = "en-US";

let finalTranscript = "";   // only finalized chunks
let interimTranscript = ""; // live (interim) chunk

let fillerCounts = {}; // term -> count
let fillerHits = [];   // {term, ms, snippet}

// ASR timing (used to avoid VAD duplicates)
let lastAsrAnyMs = 0;   // any onresult activity (interim or final)
let lastAsrFinalMs = 0; // when a final chunk arrives

// ------------------------------
// VAD (energy-based) for non-lexical interjections
// ------------------------------
let mic, amp;
let vadEnabled = true;
let micReady = false;
let micState = "off"; // off | starting | on | error
let vadCalibrating = false;
let vadCalibStart = 0;
let vadNoiseMax = 0;
let vadAutoCalibMs = 4000; // 4s


// You can tune these if needed:
let vadThreshold = 0.020;
let vadMinMs = 120;       // min duration to count as an interjection
let vadMaxMs = 1200;      // max duration to still be considered a short interjection

let vadActive = false;
let vadStartMs = 0;
let lastVadHitMs = 0;

// If ASR has produced text very recently, we assume VAD event is already represented in text
let vadIgnoreAfterAsrMs = 350;

// Rate-limit VAD hits so we don't count multiple times in one “hummm”
let vadCooldownMs = 900;

// ------------------------------
// Fillers vocabulary / heuristics
// ------------------------------

// Single-word fillers (normalized: lowercase, no accents)
const FILLERS_SINGLE = new Set([
  // EN (lexical + common interjections that ASR may output)
  "um", "uh", "erm", "er",
  "hmm", "hm", "mm", "mmm", "mhm",
  "ah", "aah", "oh", "eh",
  "like", "so", "basically", "literally", "actually", "right", "well",

  // PT (normalized)
  "tipo", "pronto", "pa", "pois", "entao", "basicamente", "literalmente",
  "hum", "humm", "hm", "mm", "mmm",
  "ah", "oh", "eh", "han"
]);

// Multi-word fillers (normalized)
const FILLERS_MULTI = [
  "you know",
  "i mean",
  "kind of",
  "sort of",
  "is like",
  // PT
  "e assim",
  "quer dizer",
  "estas a ver"
].map(normText);

// Words that are often legitimate too -> only count as filler in likely filler positions
const AMBIGUOUS_SINGLE = new Set(["so", "well", "right", "like"]);

function normText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSecureContextEnough() {
  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return location.protocol === "https:" || isLocalhost;
}

function resetFillers() {
  fillerCounts = {};
  fillerHits = [];
  finalTranscript = "";
  interimTranscript = "";
  lastAsrAnyMs = 0;
  lastAsrFinalMs = 0;
  vadActive = false;
  vadStartMs = 0;
  lastVadHitMs = 0;
}

function incCount(term, snippet) {
  fillerCounts[term] = (fillerCounts[term] || 0) + 1;
  fillerHits.push({ term, ms: millis(), snippet });
  if (fillerHits.length > 300) fillerHits.shift();
}

function scanFillersIncremental(rawChunk) {
  // rawChunk is new FINAL text chunk only (not entire transcript)
  const raw = (rawChunk || "").trim();
  if (!raw) return;

  const normalized = normText(raw);
  if (!normalized) return;

  // Extra: catch stretched interjections even if not in the set (e.g., hummm, ahhh, mmmm)
  // This detects tokens like: hum/hummm, hm/hmmm, mm/mmmm, ah/ahhh, eh/ehhh, oh/ohhh
  const tokens0 = normalized.split(" ");
  for (const w of tokens0) {
    if (/^(h+u+m+|h+m+|m+|a+h+|e+h+|o+h+)$/.test(w)) {
      incCount(w, raw);
    }
  }

  // 1) multi-word fillers (substring counting)
  for (const phrase of FILLERS_MULTI) {
    let idx = 0;
    while (true) {
      idx = normalized.indexOf(phrase, idx);
      if (idx === -1) break;
      incCount(phrase, raw);
      idx += phrase.length;
    }
  }

  // 2) single-word fillers with ambiguity heuristic
  const rawLower = raw.toLowerCase();
  const tokens = normalized.split(" ");

  for (const tok of tokens) {
    if (!FILLERS_SINGLE.has(tok)) continue;

    if (AMBIGUOUS_SINGLE.has(tok)) {
      // count only when it appears as clause starter (after punctuation / beginning)
      const re = new RegExp(`(^|[\\.\\!\\?\\;\\:\\,\\n\\r\\t]\\s*)(${tok})(\\b)`, "g");
      if (re.test(rawLower)) incCount(tok, raw);
      continue;
    }

    incCount(tok, raw);
  }
}

function highlightFillers(text) {
  let out = text;

  // multi-word first (avoid nesting)
  const multiSorted = [...FILLERS_MULTI].sort((a, b) => b.length - a.length);
  for (const phrase of multiSorted) {
    if (!phrase) continue;
    const parts = phrase.split(" ").map(escapeRegex).join("\\s+");
    const re = new RegExp(`\\b${parts}\\b`, "ig");
    out = out.replace(re, (m) => `[${m}]`);
  }

  // single words
  for (const w of FILLERS_SINGLE) {
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, "ig");
    out = out.replace(re, (m) => `{${m}}`);
  }

  // stretched interjections (display only)
  out = out.replace(/\b(h+u+m+|h+m+|m{2,}|a+h+|e+h+|o+h+)\b/ig, (m) => `{${m}}`);

  return out;
}

function escapeRegex(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateUI() {
  const btn = document.getElementById("asrToggle");
  const statusEl = document.getElementById("asrStatus");
  const langEl = document.getElementById("asrLang");
  const httpsHint = document.getElementById("httpsHint");

  if (httpsHint) httpsHint.style.display = isSecureContextEnough() ? "none" : "";

  if (btn) btn.textContent = asrEnabled ? "ASR: ON" : "ASR: OFF";
  if (statusEl) statusEl.textContent = asrStatus;
  if (langEl) langEl.value = asrLang;
}

function setupASR() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn("SpeechRecognition não disponível neste browser.");
    asrStatus = "error";
    updateUI();
    return;
  }

  speechRec = new SR();
  speechRec.lang = asrLang;
  speechRec.continuous = true;
  speechRec.interimResults = true;

  speechRec.onstart = () => {
    asrStatus = "listening";
    updateUI();
  };

  speechRec.onresult = (e) => {
    // Mark activity (interim or final)
    lastAsrAnyMs = millis();

    let newFinal = "";
    let newInterim = "";

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const txt = (res[0] && res[0].transcript) ? res[0].transcript : "";
      if (res.isFinal) newFinal += txt;
      else newInterim += txt;
    }

    if (newFinal.trim()) {
      lastAsrFinalMs = millis();
      finalTranscript = (finalTranscript + " " + newFinal).replace(/\s+/g, " ").trim();
      scanFillersIncremental(newFinal);
    }
    interimTranscript = newInterim.trim();
  };

  speechRec.onerror = (e) => {
    console.warn("ASR error:", e);
    asrStatus = "error";
    updateUI();
  };

  speechRec.onend = () => {
    if (asrEnabled) {
      try {
        speechRec.lang = asrLang;
        speechRec.start();
      } catch (_) {}
    } else {
      asrStatus = "idle";
      updateUI();
    }
  };
}

function startASR() {
  if (!speechRec) setupASR();
  if (!speechRec) return;

  if (!isSecureContextEnough()) {
    console.warn("ASR normalmente precisa de HTTPS ou localhost.");
  }

  asrEnabled = true;
  asrStatus = "listening";
  updateUI();

  try {
    speechRec.lang = asrLang;
    speechRec.start();
  } catch (_) {}
}

function stopASR() {
  asrEnabled = false;
  asrStatus = "idle";
  updateUI();
  if (speechRec) {
    try { speechRec.stop(); } catch (_) {}
  }
}

function toggleASR() {
  if (asrEnabled) stopASR();
  else startASR();
}

function bindUI() {
  const btn = document.getElementById("asrToggle");
  const langEl = document.getElementById("asrLang");

  if (btn) btn.addEventListener("click", toggleASR);

  const micBtn = document.getElementById("micEnable");
  if (micBtn) micBtn.addEventListener("click", enableMicForVAD);

  if (langEl) {
    langEl.addEventListener("change", (e) => {
      asrLang = e.target.value || "en-US";
      if (speechRec) speechRec.lang = asrLang;

      if (asrEnabled) {
        stopASR();
        startASR();
      }
      updateUI();
    });
  }

  updateUI();
}


// ------------------------------
// VAD logic (energy-based)
// ------------------------------
function updateVAD() {
  if (!vadEnabled || !amp || !micReady) return;

  const level = amp.getLevel();
  const now = millis();

  // auto-calibration window: estimate ambient noise max and set threshold a bit above it
  if (vadCalibrating) {
    vadNoiseMax = Math.max(vadNoiseMax, level);
    if (now - vadCalibStart > vadAutoCalibMs) {
      vadCalibrating = false;
      // set threshold slightly above noise max, with a sane floor
      vadThreshold = Math.max(0.015, vadNoiseMax * 2.5);
      // and cap it to avoid absurd thresholds
      vadThreshold = Math.min(vadThreshold, 0.08);
      console.log("VAD calibrated. noiseMax=", vadNoiseMax, "threshold=", vadThreshold);
    }
    // still allow VAD to run during calibration, but with a safe temporary threshold
    // (no return here)
  }

  // Start VAD
  if (!vadActive && level >= vadThreshold) {
    // basic debounce: ignore if we just recorded one
    if (now - lastVadHitMs < vadCooldownMs) return;

    vadActive = true;
    vadStartMs = now;
    return;
  }

  // End VAD
  if (vadActive && level < vadThreshold * 0.75) {
    const dur = now - vadStartMs;
    vadActive = false;

    // duration gate
    if (dur < vadMinMs || dur > vadMaxMs) return;

    // ignore if ASR was active very recently (likely already represented in text)
    if (now - lastAsrFinalMs < vadIgnoreAfterAsrMs) return;

    // Optional: if we are in "Background Noise" for a long time, be conservative
    // (but we still allow short bursts)
    // if (currentLabel === "Background Noise") return; // uncomment to be stricter

    // Record as a vocal filler event
    lastVadHitMs = now;

    // Heuristic label based on duration (useful for analysis)
    // short ~ "ah/eh", longer ~ "hum/mm"
    const label = dur < 320 ? "vocal_filler_short" : "vocal_filler_long";
    incCount(label, `VAD ${Math.round(dur)}ms`);
  }
}

// ------------------------------
// Controls
// ------------------------------

function keyPressed() {
  if (key === "d" || key === "D") {
    DEBUG_FACE = !DEBUG_FACE;
    VisionAssist.setDebugMode(DEBUG_FACE);
    console.log("Debug mode:", DEBUG_FACE);
  }
  if (key === "r" || key === "R") {
    resetFillers();
  }
  if (key === "t" || key === "T") {
    toggleASR();
  }
  if (key === "v" || key === "V") {
    vadEnabled = !vadEnabled;
  }
}

function preload() {
  classifier = ml5.soundClassifier(soundModelURL);
}

function setup() {
  createCanvas(windowWidth, windowHeight);

  video = createCapture({
    video: { width: 640, height: 480 },
    audio: false
  });

  video.size(640, 480);
  video.hide();

  VisionAssist.init(video);

  classifier.classify(gotResult);
  textFont("sans-serif");

  // UI + ASR
  bindUI();
  setupASR();
}

async function enableMicForVAD() {
  try {
    micState = "starting";
    micReady = false;

    // make sure audio context is running (Chrome requirement)
    const ctx = getAudioContext();
    if (ctx.state !== "running") {
      await ctx.resume();
    }
    userStartAudio();

    mic = new p5.AudioIn();

    // mic.start can take callbacks
    mic.start(
      () => {
        amp = new p5.Amplitude();
        amp.setInput(mic);
        micReady = true;
        micState = "on";

        // optional: auto-calibrate threshold from ambient noise
        vadCalibrating = true;
        vadCalibStart = millis();
        vadNoiseMax = 0;
      },
      (err) => {
        console.warn("mic.start error:", err);
        micState = "error";
        micReady = false;
      }
    );
  } catch (e) {
    console.warn("enableMicForVAD exception:", e);
    micState = "error";
    micReady = false;
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function draw() {
  // Draw webcam only
  drawVideoCover(video, 0, 0, width, height);

  VisionAssist.update(width, height);
  VisionAssist.drawOverlays(width, height);

  // Update VAD every frame (cheap)
  updateVAD();

  // Update pulse speed smoothly
  if (currentLabel === "Fast") {
    pulseSpeed = lerp(pulseSpeed, 0.25, 0.06);
  } else if (currentLabel === "Slow") {
    pulseSpeed = lerp(pulseSpeed, 0.03, 0.06);
  } else {
    pulseSpeed = lerp(pulseSpeed, 0.0, 0.12);
  }

  // Pulse geometry
  let expansion = sin(angle) * maxExpansion;
  let diameter = baseDiameter + expansion;

  // Visual intensity based on pace
  let alpha = map(pulseSpeed, 0, 0.25, 0, 220, true);
  let strokeW = map(pulseSpeed, 0, 0.25, 0.5, 6, true);

  // Draw ring only if speaking
  if (alpha > 8) {
    noFill();

    stroke(255, alpha);
    strokeWeight(strokeW);
    ellipse(width / 2, height / 2, diameter, diameter);

    stroke(255, alpha * 0.3);
    strokeWeight(max(1, strokeW * 0.6));
    ellipse(width / 2, height / 2, diameter * 1.12, diameter * 1.12);
  }

  angle += pulseSpeed;

  // ---------- LABEL OVERLAY ----------
  drawLabel();
}

function drawVideoCover(vid, x, y, w, h) {
  const vw = vid.elt.videoWidth || vid.width;
  const vh = vid.elt.videoHeight || vid.height;
  if (!vw || !vh) return;

  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;

  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;

  image(vid, x, y, w, h, sx, sy, sw, sh);
}

function wrapTextLines(str, maxChars) {
  const s = (str || "").trim();
  if (!s) return [];
  const words = s.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? (line + " " + w) : w;
    if (candidate.length <= maxChars) line = candidate;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawLabel() {
  let barHeight = 190;

  noStroke();
  fill(0, 150);
  rect(0, height - barHeight, width, barHeight);

  const s = VisionAssist.getScores();
  const d = VisionAssist.getDebug();

  fill(255);
  textSize(16);
  textAlign(LEFT, TOP);

  const x = 14;
  let y = height - barHeight + 10;

  text(`Audio: ${currentLabel}`, x, y);
  y += 22;

  text(`E: ${s.engagement.toFixed(2)} | faceDetected: ${d.faceDetected}`, x, y);
  y += 22;

  text(
    `centered: ${d.centered.toFixed(2)}  yaw: ${d.yawBalance.toFixed(2)}  express: ${d.express.toFixed(2)}`,
    x,
    y
  );
  y += 22;

  text(`P: ${s.posture.toFixed(2)} | level:${d.shoulderLevel.toFixed(2)} head:${d.head.toFixed(2)}`, x, y);
  y += 26;

  const top = Object.entries(fillerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");

  textSize(14);
  text(`ASR: ${asrEnabled ? "ON" : "OFF"} (${asrLang}) | VAD: ${vadEnabled ? "ON" : "OFF"} (toggle V)`, x, y);
  y += 18;

  text(`Fillers(top): ${top || "-"}`, x, y);
  y += 18;

  const combined = (finalTranscript + (interimTranscript ? " " + interimTranscript : "")).trim();
  const display = combined ? highlightFillers(combined) : "(sem transcrição)";
  const lines = wrapTextLines(display, Math.max(40, Math.floor((width - 28) / 9)));

  const last2 = lines.slice(-2);
  text(`Transcript: ${last2.join(" / ")}`, x, y);
  y += 18;

  const ctx = getAudioContext();
  const ctxState = ctx ? ctx.state : "n/a";

  if (amp) {
    const lvl = amp.getLevel();
    text(
      `Mic: ${micState} | ctx:${ctxState} | level:${lvl.toFixed(3)} | thr:${vadThreshold.toFixed(3)} | VAD:${vadEnabled ? "ON" : "OFF"} (V)`,
      x,
      y
    );
  } else {
    text(
      `Mic: ${micState} | ctx:${ctxState} | (click "Enable Mic (VAD)")`,
      x,
      y
    );
  }
}

function gotResult(error, results) {
  if (error) {
    console.error(error);
    return;
  }

  let newLabel = results[0].label;

  if (newLabel === "Fast" || newLabel === "Slow") {
    currentLabel = newLabel;
    lastSpeechTime = millis();
  } else {
    if (millis() - lastSpeechTime > silenceThreshold) {
      currentLabel = "Background Noise";
    }
  }
}

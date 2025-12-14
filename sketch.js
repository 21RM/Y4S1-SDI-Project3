// ------------------------------
// Audio pace classifier (ml5) + VisionAssist overlays
// + Filler detector (Web Speech API -> text -> regex)
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

// Single-word fillers: keep them normalized (no accents, lowercase)
const FILLERS_SINGLE = new Set([
  // EN
  "um", "uh", "erm", "hmm", "mm", "like", "so", "basically", "literally",
  "actually", "right", "well",
  // PT
  "tipo", "pronto", "pa", "pois", "entao", "basicamente", "literalmente"
]);

// Multi-word fillers (also normalized)
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

// Some words are often "real" words too (e.g. "so", "well").
// We apply a small heuristic: count it as filler only if it's at the start of a clause
// (start of text, after punctuation, or followed by comma/pause).
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
  // SpeechRecognition typically requires HTTPS or localhost.
  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return location.protocol === "https:" || isLocalhost;
}

function resetFillers() {
  fillerCounts = {};
  fillerHits = [];
  finalTranscript = "";
  interimTranscript = "";
}

function incCount(term, snippet) {
  fillerCounts[term] = (fillerCounts[term] || 0) + 1;
  fillerHits.push({ term, ms: millis(), snippet });
  if (fillerHits.length > 200) fillerHits.shift();
}

function scanFillersIncremental(rawChunk) {
  // rawChunk is new FINAL text chunk only (not entire transcript)
  const raw = (rawChunk || "").trim();
  if (!raw) return;

  const normalized = normText(raw);
  if (!normalized) return;

  // 1) multi-word fillers (simple substring counting)
  for (const phrase of FILLERS_MULTI) {
    let idx = 0;
    while (true) {
      idx = normalized.indexOf(phrase, idx);
      if (idx === -1) break;
      incCount(phrase, raw);
      idx += phrase.length;
    }
  }

  // 2) single-word fillers with a bit of punctuation awareness from raw
  const rawLower = raw.toLowerCase();
  const tokens = normalized.split(" ");

  for (const tok of tokens) {
    if (!FILLERS_SINGLE.has(tok)) continue;

    // heuristic for ambiguous singles
    if (AMBIGUOUS_SINGLE.has(tok)) {
      const re = new RegExp(`(^|[\\.\\!\\?\\;\\:\\,\\n\\r\\t]\\s*)(${tok})(\\b)`, "g");
      if (re.test(rawLower)) {
        incCount(tok, raw);
      }
      continue;
    }

    incCount(tok, raw);
  }
}

function highlightFillers(text) {
  // highlight in display only (do NOT change counting)
  let out = text;

  // multi-word first (longer first to avoid nesting)
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
    // Build final + interim
    let newFinal = "";
    let newInterim = "";

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const txt = (res[0] && res[0].transcript) ? res[0].transcript : "";
      if (res.isFinal) newFinal += txt;
      else newInterim += txt;
    }

    if (newFinal.trim()) {
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
    // Some browsers stop randomly; keep alive if enabled.
    if (asrEnabled) {
      try {
        speechRec.lang = asrLang;
        speechRec.start();
      } catch (_) {
        // ignore
      }
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
  } catch (_) {
    // already started
  }
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

  if (langEl) {
    langEl.addEventListener("change", (e) => {
      asrLang = e.target.value || "en-US";
      if (speechRec) speechRec.lang = asrLang;

      // Restart to apply lang cleanly
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

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function draw() {
  // Draw webcam only
  drawVideoCover(video, 0, 0, width, height);

  VisionAssist.update(width, height);
  VisionAssist.drawOverlays(width, height);

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
  // Simple char-based wrap (fast + stable)
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

// Bottom label overlay
function drawLabel() {
  let barHeight = 170;

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

  // ---------- FILLERS OVERLAY ----------
  const top = Object.entries(fillerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");

  textSize(14);
  text(`ASR: ${asrEnabled ? "ON" : "OFF"} (${asrLang}) | reset: R | toggle: T`, x, y);
  y += 18;

  text(`Fillers(top): ${top || "-"}`, x, y);
  y += 18;

  const combined = (finalTranscript + (interimTranscript ? " " + interimTranscript : "")).trim();
  const display = combined ? highlightFillers(combined) : "(sem transcrição)";
  const lines = wrapTextLines(display, Math.max(40, Math.floor((width - 28) / 9)));

  // show last 2 lines of transcript to keep UI clean
  const last2 = lines.slice(-2);
  text(`Transcript: ${last2.join(" / ")}`, x, y);
}

// Audio classification callback
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

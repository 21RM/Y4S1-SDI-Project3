let classifier;
let video;

let pulseSpeed = 0;
let angle = 0;
let baseDiameter = 200;
let maxExpansion = 100;

let currentLabel = "Background Noise";
let lastSpeechTime = 0;

let envDim = 0; // 0 = bright, 1 = fully dim

let DEBUG_FACE = false;

function preload() {
  classifier = ml5.soundClassifier(window.AppConfig.soundModelURL);
}

function setup() {
  createCanvas(windowWidth, windowHeight);

  colorMode(HSB, 360, 100, 100, 255);

  video = createCapture({ video: { width: 640, height: 480 }, audio: false });
  video.size(640, 480);
  video.hide();

  VisionAssist.init(video);
  classifier.classify(gotResult);

  textFont("sans-serif");

  window.Fillers.setup();
  window.AppUI.bind();
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

function keyPressed() {
  if (key === "d" || key === "D") { DEBUG_FACE = !DEBUG_FACE; VisionAssist.setDebugMode(DEBUG_FACE); }
  if (key === "r" || key === "R") { window.Fillers.reset(); window.VAD.reset(); }
  if (key === "t" || key === "T") { window.Fillers.toggle(); window.AppUI.update(); }
  if (key === "v" || key === "V") { window.VAD.toggleEnabled(); }
}

function mousePressed() {
  // fallback: click canvas to enable mic if needed
  if (!window.VAD.micReady && window.VAD.micState !== "starting") window.VAD.enableMic();
}

function draw() {
  drawVideoCover(video, 0, 0, width, height);

  VisionAssist.update(width, height);
  VisionAssist.drawOverlays(width, height);

  window.VAD.update((label, snippet) => {
    // record vocal fillers alongside text fillers
    const counts = window.Fillers.counts;
    counts[label] = (counts[label] || 0) + 1;
  });

  // Pulse speed
  if (currentLabel === "Fast") pulseSpeed = lerp(pulseSpeed, 0.25, 0.06);
  else if (currentLabel === "Slow") pulseSpeed = lerp(pulseSpeed, 0.03, 0.06);
  else pulseSpeed = lerp(pulseSpeed, 0.0, 0.12);

  let expansion = sin(angle) * maxExpansion;
  let diameter = baseDiameter + expansion;

  let hue = map(pulseSpeed, 0, 0.25, 160, 0, true);

  let alpha = map(pulseSpeed, 0, 0.25, 0, 220, true);
  let strokeW = map(pulseSpeed, 0, 0.25, 0.5, 6, true);

  // Draw ring only if speaking
  if (alpha > 8) {
    noFill();

    stroke(hue, 80, 100, alpha);
    strokeWeight(strokeW);
    ellipse(width / 2, height / 2, diameter, diameter);

    for (let i = 1; i <= 4; i++) {
      stroke(hue, 60, 100, alpha / (i + 1));
      strokeWeight(max(1, strokeW * 0.6));
      ellipse(
        width / 2,
        height / 2,
        diameter + i * 25,
        diameter + i * 25
      );
    }
  }
  
  angle += pulseSpeed;
  
  if (envDim > 0.01) {
    noStroke();
    fill(0, 0, 0, envDim * 180); // alpha controls darkness
    rect(0, 0, width, height);
  }

  drawLabel();
}

function drawVideoCover(vid, x, y, w, h) {
  const vw = vid.elt.videoWidth || vid.width;
  const vh = vid.elt.videoHeight || vid.height;
  if (!vw || !vh) return;

  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale, sh = h / scale;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

  image(vid, x, y, w, h, sx, sy, sw, sh);
}

function wrapTextLines(str, maxChars) {
  const s = (str || "").trim();
  if (!s) return [];
  const words = s.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const c = line ? (line + " " + w) : w;
    if (c.length <= maxChars) line = c;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function drawLabel() {
  const barHeight = 190;
  noStroke(); fill(0, 150);
  rect(0, height - barHeight, width, barHeight);

  const s = VisionAssist.getScores();
  const d = VisionAssist.getDebug();

  fill(255); textAlign(LEFT, TOP);

  const x = 14;
  let y = height - barHeight + 10;

  textSize(16);
  text(`Audio: ${currentLabel}`, x, y); y += 22;
  text(`E: ${s.engagement.toFixed(2)} | faceDetected: ${d.faceDetected}`, x, y); y += 22;
  text(`centered: ${d.centered.toFixed(2)}  yaw: ${d.yawBalance.toFixed(2)}  express: ${d.express.toFixed(2)}`, x, y); y += 22;
  text(`P: ${s.posture.toFixed(2)} | level:${d.shoulderLevel.toFixed(2)} head:${d.head.toFixed(2)}`, x, y); y += 26;

  textSize(14);
  text(`ASR: ${window.Fillers.enabled ? "ON" : "OFF"} (${window.Fillers.lang}) | VAD: ${window.VAD.enabled ? "ON" : "OFF"} | reset:R toggleASR:T toggleVAD:V`, x, y);
  y += 18;

  const top = Object.entries(window.Fillers.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  text(`Fillers(top): ${top || "-"}`, x, y); y += 18;

  const combined = window.Fillers.combinedTranscript();
  const display = combined ? window.Fillers.highlight(combined) : "(sem transcrição)";
  const lines = wrapTextLines(display, Math.max(40, Math.floor((width - 28) / 9)));
  text(`Transcript: ${lines.slice(-2).join(" / ")}`, x, y); y += 18;

  const ctx = getAudioContext();
  const lvl = window.VAD.getLevel();

  // target dim: silence → darker
  let targetDim = 1;

  // if mic is active and sound exists, reduce dim
  if (lvl != null) {
    targetDim = map(lvl, 0.0, window.AppConfig.vad.threshold, 1, 0, true);
  }

  // smooth transition
  envDim = lerp(envDim, targetDim, 0.06);

  text(
    `Mic: ${window.VAD.micState} | ctx:${ctx ? ctx.state : "n/a"} | level:${lvl == null ? "n/a" : lvl.toFixed(3)} | thr:${window.AppConfig.vad.threshold.toFixed(3)}`,
    x,
    y
  );
}

function gotResult(error, results) {
  if (error) return console.error(error);

  const newLabel = results[0].label;
  if (newLabel === "Fast" || newLabel === "Slow") {
    currentLabel = newLabel;
    lastSpeechTime = millis();
  } else {
    if (millis() - lastSpeechTime > window.AppConfig.silenceThresholdMs) {
      currentLabel = "Background Noise";
    }
  }
}
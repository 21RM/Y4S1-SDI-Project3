// ML
let classifier;
let soundModelURL =
  "https://teachablemachine.withgoogle.com/models/I-GA10wfZ/model.json";

// Webcam
let video;

// Visual pulse
let pulseSpeed = 0;
let angle = 0;
let baseDiameter = 200;
let maxExpansion = 100;

// State smoothing
let currentLabel = "Background Noise";
let lastSpeechTime = 0;
let silenceThreshold = 1000;

let DEBUG_FACE = false;

function keyPressed() {
  if (key === 'd' || key === 'D') {
    DEBUG_FACE = !DEBUG_FACE;
    VisionAssist.setDebugMode(DEBUG_FACE);
    console.log("Debug mode:", DEBUG_FACE);
  }
}

function preload() {
  classifier = ml5.soundClassifier(soundModelURL);
}

function setup() {
  createCanvas(windowWidth, windowHeight);

  colorMode(HSB, 360, 100, 100, 255);

  video = createCapture({
    video: { width: 640, height: 480 },
    audio: false
  });

  video.size(640, 480);
  video.hide();

  VisionAssist.init(video);

  classifier.classify(gotResult);
  textFont("sans-serif");
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

  // Map pace → color (green → yellow → red)
  let hue = map(pulseSpeed, 0, 0.25, 160, 0, true);

  // Visual intensity based on pace
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

// Bottom label overlay
function drawLabel() {
  let barHeight = 90;

  noStroke();
  fill(0, 150);
  rect(0, height - barHeight, width, barHeight);

  const s = VisionAssist.getScores();
  const d = VisionAssist.getDebug();

  fill(255);
  textSize(16);
  textAlign(LEFT, TOP);

  const x = 14;
  const y = height - barHeight + 10;

  text(`Audio: ${currentLabel}`, x, y);
  text(`E: ${s.engagement.toFixed(2)} | faceDetected: ${d.faceDetected}`, x, y + 22);
  text(`centered: ${d.centered.toFixed(2)}  yaw: ${d.yawBalance.toFixed(2)}  express: ${d.express.toFixed(2)}`, x, y + 44);
  text(`P: ${s.posture.toFixed(2)} | level:${d.shoulderLevel.toFixed(2)} head:${d.head.toFixed(2)}`, x, y + 66);

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
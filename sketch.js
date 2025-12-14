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

function preload() {
  classifier = ml5.soundClassifier(soundModelURL);
}

function setup() {
  createCanvas(640, 480);

  // Webcam setup
  video = createCapture({
    video: {
      width: 640,
      height: 480
    },
    audio: false
  });

  video.size(width, height);
  video.hide();

  video.elt.onloadedmetadata = () => {
    console.log("Webcam ready");
  };

  // Start audio classification
  classifier.classify(gotResult);

  textFont("sans-serif");
}

function draw() {
  // Draw webcam only
  image(video, 0, 0, width, height);

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
    ellipse(
      width / 2,
      height / 2,
      diameter * 1.12,
      diameter * 1.12
    );
  }

  angle += pulseSpeed;

  // ---------- LABEL OVERLAY ----------
  drawLabel();
}

// Bottom label overlay
function drawLabel() {
  let padding = 10;
  let barHeight = 36;

  noStroke();
  fill(0, 120); // semi-transparent black
  rect(0, height - barHeight, width, barHeight);

  fill(255);
  textSize(16);
  textAlign(CENTER, CENTER);
  text(
    currentLabel,
    width / 2,
    height - barHeight / 2
  );
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
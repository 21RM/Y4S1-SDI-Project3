window.VisionAssist = (() => {

    // DEBUG
    let debugMode = false;

    // store last raw feature values
    let dbg = {
        faceDetected: false,
        centered: 0,
        yawBalance: 0,
        express: 0,
        centerDist: 0,
        dl: 0,
        dr: 0
    };

    // store keypoints for drawing
    let dbgPts = {
        nose: null,
        leftEye: null,
        rightEye: null,
        upLip: null,
        lowLip: null
    };

    dbg.poseDetected = false;
    dbg.shoulderLevel = 0;
    dbg.head = 0;
    dbg.torsoAngle = 0;
    dbg.shoulderDiffRatio = 0;

    // Pose keypoints we’ll draw (video-space)
    let dbgPosePts = {
        nose: null,
        ls: null, rs: null,
        lh: null, rh: null,
        shMid: null,
        hipMid: null
    };
    // END OF DEBUG

    let videoRef = null;
  
    let faceMesh, poseNet;
    let facePreds = [];
    let posePreds = [];

    let engageEMA = 0;
    let postureEMA = 0;

    let vignetteA = 0;
    let horizonTilt = 0;
    let aura = 0;

    const clamp01 = (x) => Math.max(0, Math.min(1, x));

    function init(video) {
        videoRef = video;
        const faceCtor = ml5.facemesh || ml5.faceMesh;
        if (!faceCtor) {
            console.error("No FaceMesh in this ml5 build.");
            return;
        }
        faceMesh = faceCtor(video, () => console.log("FaceMesh ready"));
        faceMesh.on("predict", (results) => (facePreds = results || []));

        poseNet = ml5.poseNet(video, { flipHorizontal: false }, () =>
            console.log("PoseNet ready")
        );
        poseNet.on("pose", (results) => (posePreds = results || []));
    }

    function computeEngagement(w, h) {
        dbg.faceDetected = facePreds.length > 0;
        dbgPts.nose = dbgPts.leftEye = dbgPts.rightEye = dbgPts.upLip = dbgPts.lowLip = null;

        if (!facePreds.length) {
            dbg.centered = dbg.yawBalance = dbg.express = 0;
            dbg.centerDist = dbg.dl = dbg.dr = 0;
            return 0;
        }

        const p = facePreds[0];
        const ann = p.annotations;
        if (!ann || !ann.noseTip || !ann.leftEyeUpper0 || !ann.rightEyeUpper0) {
            dbg.centered = dbg.yawBalance = dbg.express = 0.4;
            return 0.4;
        }

        const nose = ann.noseTip[0];
        const leftEye = ann.leftEyeUpper0[3];
        const rightEye = ann.rightEyeUpper0[3];

        dbgPts.nose = nose;
        dbgPts.leftEye = leftEye;
        dbgPts.rightEye = rightEye;

        const centerDist = Math.abs(nose[0] - w / 2);
        const centered = 1 - clamp01(centerDist / (w * 0.35));

        const dl = dist(nose[0], nose[1], leftEye[0], leftEye[1]);
        const dr = dist(nose[0], nose[1], rightEye[0], rightEye[1]);
        const eyeDist = dist(leftEye[0], leftEye[1], rightEye[0], rightEye[1]);
        const yawBalance = 1 - clamp01(Math.abs(dl - dr) / Math.max(dl, dr));

        let express = 0.5;
        if (ann.lipsUpperInner && ann.lipsLowerInner && eyeDist > 1) {
            const up = ann.lipsUpperInner[5];
            const low = ann.lipsLowerInner[5];
            dbgPts.upLip = up;
            dbgPts.lowLip = low;
            const mouthOpenPx = dist(up[0], up[1], low[0], low[1]);
            const mouthRatio = mouthOpenPx / eyeDist;
            express = clamp01((mouthRatio - 0.03) / 0.09);
        }

        //save debug values
        dbg.centerDist = centerDist;
        dbg.centered = centered;
        dbg.dl = dl;
        dbg.dr = dr;
        dbg.yawBalance = yawBalance;
        dbg.express = express;

        return clamp01(0.60 * yawBalance + 0.25 * centered + 0.15 * express);
    }

    function update(canvasW, canvasH) {
        const t = getCoverTransform(canvasW, canvasH);
        if (!t) return;

        const e = computeEngagement(t.vw, t.vh);
        engageEMA = lerp(engageEMA, e, 0.08);
        vignetteA = lerp(vignetteA, map(engageEMA, 0, 1, 180, 0, true), 0.08);

        const p = computePosture(t.vw, t.vh);
        postureEMA = lerp(postureEMA, p, 0.08);

        aura = clamp01((engageEMA + postureEMA) / 2);

        const sign = dbg.torsoAngle >= 0 ? 1 : -1;
        const mag = map(postureEMA, 0, 1, 0.12, 0.0, true);
        horizonTilt = lerp(horizonTilt, sign * mag, 0.08);
    }

    function drawOverlays(w, h) {
        const t = getCoverTransform(w, h);
        if (!t) return;

        drawShoulderLine(t);
        drawHeadHalo(t);
        drawExpressBar(w, h);
        drawCenterArrows(w, h);

        if (debugMode) {
            drawFaceDebug(t);
            drawPoseDebug(t);
        }
    }

    function drawShoulderLine(t) {
        if (!dbg.poseDetected) return;
        if (!dbgPosePts.ls || !dbgPosePts.rs) return;

        const L = mapVideoPtToCanvas([dbgPosePts.ls.x, dbgPosePts.ls.y], t);
        const R = mapVideoPtToCanvas([dbgPosePts.rs.x, dbgPosePts.rs.y], t);

        const good = clamp01(dbg.shoulderLevel);
        const bad = 1 - good;

        const aMain = map(bad, 0, 1, 60, 220, true);
        const wMain = map(bad, 0, 1, 2, 7, true);

        const colBad = color(255, 60, 60);
        const colGood = color(80, 255, 120);
        const col = lerpColor(colGood, colBad, good);

        stroke(col.levels[0], col.levels[1], col.levels[2], aMain);
        strokeWeight(wMain);
        line(L[0], L[1], R[0], R[1]);

        const aGlow = map(good, 0, 1, 0, 120, true);
        stroke(col.levels[0], col.levels[1], col.levels[2], aGlow);
        strokeWeight(2);
        line(L[0], L[1] - 6, R[0], R[1] - 6);
    }

    function drawHeadHalo(t) {
        if (!dbg.poseDetected) return;
        if (!dbgPosePts.nose) return;

        const N = mapVideoPtToCanvas([dbgPosePts.nose.x, dbgPosePts.nose.y], t);

        const good = clamp01(dbg.head);
        const bad = 1 - good;

        const yOffset = map(bad, 0, 1, 200, 180, true);
        const cx = N[0];
        const cy = N[1] - yOffset;

        const r = map(bad, 0, 1, 80, 50, true);
        const a = map(bad, 0, 1, 60, 190, true);

        if (a < 2) return;

        const colBad = color(255, 80, 80);
        const colGood = color(120, 255, 160);
        const col = lerpColor(colGood, colBad, good);

        noFill();

        stroke(col.levels[0], col.levels[1], col.levels[2], a);
        strokeWeight(10);
        ellipse(cx, cy, r * 2.2, r * 1.4);

        stroke(col.levels[0], col.levels[1], col.levels[2], a * 0.45);
        strokeWeight(4);
        ellipse(cx, cy, r * 1.7, r * 1.1);

        const hintA = map(bad, 0, 1, 0, 160, true);
        if (hintA > 5) {
            stroke(col.levels[0], col.levels[1], col.levels[2], hintA);
            strokeWeight(3);
            line(cx, cy + r * 0.85, cx, cy + r * 0.35);
            line(cx, cy + r * 0.35, cx - 10, cy + r * 0.50);
            line(cx, cy + r * 0.35, cx + 10, cy + r * 0.50);
        }
    }


    function drawExpressBar(w, h) {
        const pad = 18;
        const barW = 18;
        const barH = Math.min(220, h * 0.35);
        const x = w - pad - barW;
        const y = h * 0.5 - barH / 2;

        noStroke();
        fill(0, 120);
        rect(x - 6, y - 6, barW + 12, barH + 12, 10);

        const v = clamp01(engageEMA);
        const fillH = barH * v;

        const colLow = color(255, 80, 80);
        const colHigh = color(120, 255, 160);
        const col = lerpColor(colHigh, colLow, v);

        fill(col.levels[0], col.levels[1], col.levels[2], 200);
        rect(x, y + (barH - fillH), barW, fillH, 8);

        noFill();
        stroke(255, 90);
        strokeWeight(2);
        rect(x, y, barW, barH, 8);

        const thresh = 0.55;
        const ty = y + barH * (1 - thresh);
        stroke(255, 120);
        line(x - 6, ty, x + barW + 6, ty);
    }

    function drawCenterArrows(w, h) {
        if (!dbg.faceDetected) return;

        const centered = clamp01(dbg.centered);  
        const off = 1 - centered;            

        if (off < 0.10) return;
        let dir = 0;
        if (dbgPts.nose) {
            const t = getCoverTransform(w, h);
            if (!t) return;
            const [nx, ny] = mapVideoPtToCanvas(dbgPts.nose, t);
            dir = (nx < w / 2) ? -1 : 1;
        } else {
            return;
        }

        const a = map(off, 0.10, 1.0, 0, 180, true);
        const pulse = 0.6 + 0.4 * Math.sin(millis() * 0.006);
        const alpha = a * pulse;

        const margin = 40;
        const y = h * 0.5;
        const x = (dir < 0) ? margin : (w - margin);

        const size = map(off, 0.10, 1.0, 18, 40, true);
        const gap = 14;

        stroke(255, 0, 0, alpha);
        strokeWeight(6);
        strokeCap(ROUND);
        noFill();

        drawChevron(x, y, size, dir);
        drawChevron(x - dir * gap, y, size * 0.85, dir);
    }

    function drawChevron(x, y, s, dir) {
        const dx = -dir * s;
        line(x - dx, y - s * 0.6, x, y);
        line(x - dx, y + s * 0.6, x, y);
    }


    function drawFaceDebug(t) {
        const drawMapped = (pt, r, col) => {
            if (!pt) return;
            const [x, y] = mapVideoPtToCanvas(pt, t);
            stroke(col[0], col[1], col[2]);
            fill(col[0], col[1], col[2]);
            circle(x, y, r);
        };

        drawMapped(dbgPts.nose, 12, [0,255,0]);
        drawMapped(dbgPts.leftEye, 10, [0,255,0]);
        drawMapped(dbgPts.rightEye, 10, [0,255,0]);
        drawMapped(dbgPts.upLip, 9, [255,255,0]);
        drawMapped(dbgPts.lowLip, 9, [255,255,0]);
    }

    function drawPoseDebug(t) {
        const mapP = (p) => {
            if (!p) return null;
            return mapVideoPtToCanvas([p.x, p.y], t);
        };

        const nose = mapP(dbgPosePts.nose);
        const ls = mapP(dbgPosePts.ls);
        const rs = mapP(dbgPosePts.rs);
        const lh = mapP(dbgPosePts.lh);
        const rh = mapP(dbgPosePts.rh);
        const shMid = dbgPosePts.shMid ? mapVideoPtToCanvas([dbgPosePts.shMid.x, dbgPosePts.shMid.y], t) : null;
        const hipMid = dbgPosePts.hipMid ? mapVideoPtToCanvas([dbgPosePts.hipMid.x, dbgPosePts.hipMid.y], t) : null;

        const dot = (pt, r) => { if (!pt) return; circle(pt[0], pt[1], r); };

        stroke(0, 200, 255); fill(0, 200, 255); strokeWeight(2);
        dot(nose, 10); dot(ls, 10); dot(rs, 10); dot(lh, 10); dot(rh, 10);
        stroke(255, 0, 200); fill(255, 0, 200);
        dot(shMid, 8); dot(hipMid, 8);

        stroke(0, 200, 255); noFill(); strokeWeight(3);
        if (ls && rs) line(ls[0], ls[1], rs[0], rs[1]);
        if (lh && rh) line(lh[0], lh[1], rh[0], rh[1]);
        if (shMid && hipMid) line(shMid[0], shMid[1], hipMid[0], hipMid[1]);
    }


    function getScores() {
        return {
            engagement: engageEMA,
            posture: postureEMA,
            aura
        };
    }

    function setDebugMode(v) {
        debugMode = !!v;
    }

    function getDebug() {
        return { ...dbg, ...dbgPts };
    }

    function getCoverTransform(canvasW, canvasH) {
        const vw = videoRef?.elt?.videoWidth || videoRef?.width;
        const vh = videoRef?.elt?.videoHeight || videoRef?.height;
        if (!vw || !vh) return null;

        const scale = Math.max(canvasW / vw, canvasH / vh);

        const offsetX = (canvasW - vw * scale) / 2;
        const offsetY = (canvasH - vh * scale) / 2;

        return { vw, vh, scale, offsetX, offsetY };
    }

    function mapVideoPtToCanvas(pt, t) {
        return [pt[0] * t.scale + t.offsetX, pt[1] * t.scale + t.offsetY];
    }

    // POSTURE ___________________________________________________-----

    function computePosture(vw, vh) {
        dbg.poseDetected = posePreds.length > 0;
        dbgPosePts.nose = dbgPosePts.ls = dbgPosePts.rs = dbgPosePts.lh = dbgPosePts.rh = null;
        dbgPosePts.shMid = dbgPosePts.hipMid = null;

        if (!posePreds.length) {
            dbg.shoulderLevel = dbg.head = 0;
            dbg.torsoAngle = dbg.shoulderDiffRatio = 0;
            return 0;
        }

        const pose = posePreds[0].pose;
        if (!pose || !pose.leftShoulder || !pose.rightShoulder || !pose.leftHip || !pose.rightHip) return 0;

        const ls = pose.leftShoulder, rs = pose.rightShoulder;
        const lh = pose.leftHip, rh = pose.rightHip;
        const nose = pose.nose;

        dbgPosePts.ls = ls; dbgPosePts.rs = rs;
        dbgPosePts.lh = lh; dbgPosePts.rh = rh;
        dbgPosePts.nose = nose;

        const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
        const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
        dbgPosePts.shMid = shMid;
        dbgPosePts.hipMid = hipMid;

        const shoulderW = dist(ls.x, ls.y, rs.x, rs.y);
        const torsoLen = dist(shMid.x, shMid.y, hipMid.x, hipMid.y);

        const shoulderDiff = Math.abs(ls.y - rs.y);
        const shoulderDiffRatio = shoulderW > 1 ? shoulderDiff / shoulderW : 1;
        const shoulderLevel = 1 - clamp01(shoulderDiffRatio / 0.25);

        let head = 0.6;
        if (nose && torsoLen > 1) {
            const headToShoulders = shMid.y - nose.y;
            const headRatio = headToShoulders / torsoLen;
            head = clamp01((headRatio - 0.10) / 0.35)
        }

        dbg.shoulderLevel = shoulderLevel;
        dbg.head = head;
        dbg.shoulderDiffRatio = shoulderDiffRatio;

        return clamp01(0.40 * shoulderLevel + 0.60 * head);
    }

    return { init, update, drawOverlays, getScores, setDebugMode, getDebug };
})();
window.Fillers = (() => {
  let speechRec = null;
  let enabled = false;
  let status = "idle";
  let lang = window.AppConfig.asr.defaultLang;

  let finalTranscript = "";
  let interimTranscript = "";

  let counts = {};
  let hits = [];

  let lastAsrAnyMs = 0;
  let lastAsrFinalMs = 0;

  const AMBIGUOUS_SINGLE = new Set(["so", "well", "right", "like"]);

  const FILLERS_SINGLE = new Set([
    // EN
    "um","uh","erm","er","hmm","hm","mm","mmm","mhm","ah","aah","oh","eh",
    "like","so","basically","literally","actually","right","well",
    // PT (normalized)
    "tipo","pronto","pa","pois","entao","basicamente","literalmente",
    "hum","humm","hm","mm","mmm","ah","oh","eh","han"
  ]);

  const FILLERS_MULTI = [
    "you know","i mean","kind of","sort of","is like",
    "e assim","quer dizer","estas a ver"
  ].map(normText);

  function normText(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s']/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeRegex(s) {
    return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function inc(term, snippet) {
    counts[term] = (counts[term] || 0) + 1;
    hits.push({ term, ms: millis(), snippet });
    if (hits.length > 300) hits.shift();
  }

  function reset() {
    counts = {};
    hits = [];
    finalTranscript = "";
    interimTranscript = "";
    lastAsrAnyMs = 0;
    lastAsrFinalMs = 0;
  }

  function scanFinalChunk(rawChunk) {
    const raw = (rawChunk || "").trim();
    if (!raw) return;

    const normalized = normText(raw);
    if (!normalized) return;

    // stretched interjections (hum/hmm/mm/ahhh...)
    const toks0 = normalized.split(" ");
    for (const w of toks0) {
      if (/^(h+u+m+|h+m+|m+|a+h+|e+h+|o+h+)$/.test(w)) inc(w, raw);
    }

    // multi-word
    for (const phrase of FILLERS_MULTI) {
      let idx = 0;
      while (true) {
        idx = normalized.indexOf(phrase, idx);
        if (idx === -1) break;
        inc(phrase, raw);
        idx += phrase.length;
      }
    }

    // single-word (with ambiguity heuristic)
    const rawLower = raw.toLowerCase();
    const toks = normalized.split(" ");
    for (const tok of toks) {
      if (!FILLERS_SINGLE.has(tok)) continue;

      if (AMBIGUOUS_SINGLE.has(tok)) {
        const re = new RegExp(`(^|[\\.\\!\\?\\;\\:\\,\\n\\r\\t]\\s*)(${tok})(\\b)`, "g");
        if (re.test(rawLower)) inc(tok, raw);
      } else {
        inc(tok, raw);
      }
    }
  }

  function highlight(text) {
    let out = text || "";

    // multi first
    const multiSorted = [...FILLERS_MULTI].sort((a, b) => b.length - a.length);
    for (const phrase of multiSorted) {
      if (!phrase) continue;
      const parts = phrase.split(" ").map(escapeRegex).join("\\s+");
      const re = new RegExp(`\\b${parts}\\b`, "ig");
      out = out.replace(re, (m) => `[${m}]`);
    }

    // single
    for (const w of FILLERS_SINGLE) {
      const re = new RegExp(`\\b${escapeRegex(w)}\\b`, "ig");
      out = out.replace(re, (m) => `{${m}}`);
    }

    // stretched (display)
    out = out.replace(/\b(h+u+m+|h+m+|m{2,}|a+h+|e+h+|o+h+)\b/ig, (m) => `{${m}}`);
    return out;
  }

  function setup() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      status = "error";
      return;
    }

    speechRec = new SR();
    speechRec.lang = lang;
    speechRec.continuous = window.AppConfig.asr.continuous;
    speechRec.interimResults = window.AppConfig.asr.interimResults;

    speechRec.onstart = () => { status = "listening"; };
    speechRec.onerror = () => { status = "error"; };

    speechRec.onresult = (e) => {
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
        scanFinalChunk(newFinal);
      }
      interimTranscript = newInterim.trim();
    };

    speechRec.onend = () => {
      if (enabled) {
        try { speechRec.lang = lang; speechRec.start(); } catch (_) {}
      } else {
        status = "idle";
      }
    };
  }

  function start() {
    if (!speechRec) setup();
    if (!speechRec) return;

    enabled = true;
    status = "listening";
    try { speechRec.lang = lang; speechRec.start(); } catch (_) {}
  }

  function stop() {
    enabled = false;
    status = "idle";
    try { speechRec && speechRec.stop(); } catch (_) {}
  }

  function toggle() { enabled ? stop() : start(); }

  function setLang(newLang) {
    lang = newLang || window.AppConfig.asr.defaultLang;
    if (speechRec) speechRec.lang = lang;
    if (enabled) { stop(); start(); }
  }

  function combinedTranscript() {
    return (finalTranscript + (interimTranscript ? " " + interimTranscript : "")).trim();
  }

  return {
    setup,
    start,
    stop,
    toggle,
    reset,
    setLang,

    // getters
    get enabled() { return enabled; },
    get status() { return status; },
    get lang() { return lang; },
    get counts() { return counts; },
    get hits() { return hits; },
    get lastAsrFinalMs() { return lastAsrFinalMs; },
    combinedTranscript,
    highlight
  };
})();
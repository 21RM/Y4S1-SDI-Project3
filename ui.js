window.AppUI = (() => {
  function isSecureContextEnough() {
    const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    return location.protocol === "https:" || isLocalhost;
  }

  function update() {
    const asrBtn = document.getElementById("asrToggle");
    const statusEl = document.getElementById("asrStatus");
    const langEl = document.getElementById("asrLang");
    const httpsHint = document.getElementById("httpsHint");

    if (httpsHint) httpsHint.style.display = isSecureContextEnough() ? "none" : "";

    if (asrBtn) asrBtn.textContent = window.Fillers.enabled ? "ASR: ON" : "ASR: OFF";
    if (statusEl) statusEl.textContent = window.Fillers.status;
    if (langEl) langEl.value = window.Fillers.lang;
  }

  function bind() {
    const asrBtn = document.getElementById("asrToggle");
    const langEl = document.getElementById("asrLang");
    const micBtn = document.getElementById("micEnable");

    if (asrBtn) asrBtn.addEventListener("click", () => { window.Fillers.toggle(); update(); });
    if (micBtn) micBtn.addEventListener("click", () => window.VAD.enableMic());

    if (langEl) {
      langEl.addEventListener("change", (e) => {
        window.Fillers.setLang(e.target.value);
        update();
      });
    }

    update();
  }

  return { bind, update };
})();
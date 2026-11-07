/* ═══════════════════════════════════════════════════════════════════════
   ESPER — Photo Analysis Unit · client
   "Enhance 224 to 176." — R. Deckard, Los Angeles, 2019
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* ── stato ─────────────────────────────────────────────────────────── */
  const S = {
    photo: null,            // {id, w, h, name}
    baseImg: null,
    scale: 1, tx: 0, ty: 0,
    fitScale: 1,
    tiles: [],              // {rect, img, el}
    busy: false,
    anim: null,
    motion: null,           // pan continuo
    autoEnhance: false,
    audio: true,
    lastMeta: null,
    prefetch: null,
    render: "ai",
    lastZoomDir: 1,
    holdDir: 0,
  };

  const viewport = $("#viewport");
  const screenEl = $("#screen");
  const world = $("#world");
  const base = $("#base");
  const tilesEl = $("#tiles");

  /* ── utility ───────────────────────────────────────────────────────── */
  const now = () => new Date().toTimeString().slice(0, 8);
  const pad4 = (n) => String(Math.round(clamp(n, 0, 9999))).padStart(4, "0");
  const fmtCoord = (v) => String(Math.max(0, Math.round(v))).padStart(4, "0");
  const setField = (sel, val) => {
    const el = $(sel);
    if (el && document.activeElement !== el) el.value = val;
  };

  function log(cmd, detail) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="t">${now()}</span><b>&gt; ${cmd}</b>${detail ? " " + detail : ""}`;
    const box = $("#log");
    box.prepend(li);
    while (box.children.length > 40) box.lastChild.remove();
  }

  function setStatus(txt, cls) {
    $("#status-text").textContent = txt;
    const led = $("#led");
    led.className = "led" + (cls ? " " + cls : "");
  }

  function beep(freq = 880, dur = 0.045, type = "square", gain = 0.035) {
    if (!S.audio) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!beep.ctx) beep.ctx = new AC();
      const ctx = beep.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.stop(ctx.currentTime + dur + 0.01);
    } catch (_) { /* silenzio */ }
  }

  /* ── effetti sonori: campioni estratti dalla scena del film ────────── */
  const SFX = { ctx: null, buffers: {}, master: 0.55 };

  async function initSfx() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!SFX.ctx) SFX.ctx = new AC();
      const names = ["select", "zoom", "enhance", "shutter", "paper", "fault", "hum"];
      await Promise.all(names.map(async (n) => {
        if (SFX.buffers[n]) return;
        const r = await fetch(`/static/audio/${n}.wav`, { cache: "force-cache" });
        if (!r.ok) throw new Error(n);
        SFX.buffers[n] = await SFX.ctx.decodeAudioData(await r.arrayBuffer());
      }));
    } catch (_) {
      /* restano i beep sintetici */
    }
  }

  function playSfx(name, opts = {}) {
    if (!S.audio) return;
    const vol = opts.vol === undefined ? 1 : opts.vol;
    const rate = opts.rate || 1;
    if (!SFX.ctx || !SFX.buffers[name]) {
      beep(name === "shutter" ? 1320 : 980, 0.045, "square", 0.028);
      return;
    }
    try {
      if (SFX.ctx.state === "suspended") SFX.ctx.resume();
      const src = SFX.ctx.createBufferSource();
      src.buffer = SFX.buffers[name];
      src.playbackRate.value = rate;
      const g = SFX.ctx.createGain();
      g.gain.value = SFX.master * vol;
      src.connect(g);
      g.connect(SFX.ctx.destination);
      src.start();
    } catch (_) { /* silenzio */ }
  }

  // ── ronzio continuo della macchina ──
  let humSrc = null, humGain = null;
  function startHum() {
    if (!S.audio || !SFX.ctx || !SFX.buffers.hum || humSrc) return;
    try {
      if (SFX.ctx.state === "suspended") SFX.ctx.resume();
      humSrc = SFX.ctx.createBufferSource();
      humSrc.buffer = SFX.buffers.hum;
      humSrc.loop = true;
      humGain = SFX.ctx.createGain();
      humGain.gain.value = 0.0001;
      humSrc.connect(humGain);
      humGain.connect(SFX.ctx.destination);
      humSrc.start();
      humGain.gain.exponentialRampToValueAtTime(0.045, SFX.ctx.currentTime + 2.2);
    } catch (_) { humSrc = null; }
  }

  function stopHum(fast = false) {
    if (!humSrc) return;
    const src = humSrc;
    humSrc = null;
    try {
      const now = SFX.ctx.currentTime;
      humGain.gain.cancelScheduledValues(now);
      humGain.gain.setValueAtTime(Math.max(humGain.gain.value, 0.0001), now);
      humGain.gain.exponentialRampToValueAtTime(0.0001, now + (fast ? 0.15 : 0.9));
      setTimeout(() => { try { src.stop(); } catch (_) {} }, fast ? 260 : 1000);
    } catch (_) { try { src.stop(); } catch (_) {} }
  }

  // il browser sblocca l'audio solo dopo un gesto
  const unlockAudio = () => {
    if (SFX.ctx && SFX.ctx.state === "suspended") SFX.ctx.resume();
    startHum();
    window.removeEventListener("pointerdown", unlockAudio);
    window.removeEventListener("keydown", unlockAudio);
  };
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);

  /* ── temi del fosforo ──────────────────────────────────────────────────
     Il tema cambia la tinta del vetro (testo, bordi, griglia, glow, tinta
     della lastra), non la fotografia. Un solo atributo su <html> e tutto
     il CSS segue, perché i colori sono variabili. */
  const THEMES = ["chromo", "amber", "green", "red", "blue"];
  const THEME_LABEL = { chromo: "CIANO", amber: "AMBRA", green: "VERDE", red: "ROSSO", blue: "BLU" };

  function setTheme(name, quiet) {
    const t = THEMES.includes(name) ? name : "chromo";
    if (t === "chromo") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    document.querySelectorAll(".tdot").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
    try { localStorage.setItem("esper.theme", t); } catch (_) {}
    if (!quiet) log("THEME", THEME_LABEL[t]);
    return true;
  }

  function cycleTheme() {
    const cur = document.documentElement.dataset.theme || "chromo";
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    setTheme(next);
    playSfx("select", { vol: 0.7, rate: 1.05 });
    return true;
  }

  /* ── vista ─────────────────────────────────────────────────────────── */
  function vpSize() {
    return { w: viewport.clientWidth, h: viewport.clientHeight };
  }

  function applyView(animate = false) {
    world.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.scale})`;
    updateHud();
    if (!animate) return;
  }

  function fitView() {
    if (!S.photo) return;
    const { w: vw, h: vh } = vpSize();
    const s = Math.min(vw / S.photo.w, vh / S.photo.h) * 0.94;
    S.fitScale = s;
    S.scale = s;
    S.tx = (vw - S.photo.w * s) / 2;
    S.ty = (vh - S.photo.h * s) / 2;
    applyView();
  }

  function clampPan() {
    if (!S.photo) return;
    const { w: vw, h: vh } = vpSize();
    const w = S.photo.w * S.scale, h = S.photo.h * S.scale;
    const margin = 80;
    S.tx = w <= vw ? (vw - w) / 2 : clamp(S.tx, vw - w - margin, margin);
    S.ty = h <= vh ? (vh - h) / 2 : clamp(S.ty, vh - h - margin, margin);
  }

  function zoomAt(px, py, factor, animate = true) {
    if (!S.photo) return;
    const target = clamp(S.scale * factor, S.fitScale * 0.6, Math.max(S.fitScale * 40, 24));
    const real = target / S.scale;
    const nx = (px - S.tx) / S.scale;
    const ny = (py - S.ty) / S.scale;
    const to = {
      scale: target,
      tx: px - nx * target,
      ty: py - ny * target,
    };
    if (!animate) {
      S.scale = to.scale; S.tx = to.tx; S.ty = to.ty;
      clampPan(); applyView();
      return;
    }
    // mantieni il punto sotto il cursore durante il tween
    const from = { scale: S.scale, tx: S.tx, ty: S.ty };
    tweenView(to, 200, null, () => {
      // correzione: il tween lineare non conserva esattamente il punto
      S.tx = px - nx * S.scale;
      S.ty = py - ny * S.scale;
      clampPan();
    });
  }


  // tween semplice della vista
  let tween = null;
  function tweenView(to, ms = 320, onFrame, done) {
    if (tween) cancelAnimationFrame(tween.raf);
    const from = { scale: S.scale, tx: S.tx, ty: S.ty };
    const t0 = performance.now();
    const step = (t) => {
      const k = clamp((t - t0) / ms, 0, 1);
      const e = easeOut(k);
      S.scale = lerp(from.scale, to.scale, e);
      S.tx = lerp(from.tx, to.tx, e);
      S.ty = lerp(from.ty, to.ty, e);
      applyView();
      if (onFrame) onFrame(e);
      if (k < 1) tween.raf = requestAnimationFrame(step);
      else { tween = null; if (done) done(); }
    };
    tween = { raf: requestAnimationFrame(step) };
  }

  function screenToNative(px, py) {
    return { x: (px - S.tx) / S.scale, y: (py - S.ty) / S.scale };
  }

  function centerNative() {
    const { w: vw, h: vh } = vpSize();
    return screenToNative(vw / 2, vh / 2);
  }

  /* ── ROI dal bracket (screen-space fisso) ──────────────────────────── */
  function bracketRect() {
    const { w: vw, h: vh } = vpSize();
    const w = vw * 0.62, h = vh * 0.62;
    return { left: (vw - w) / 2, top: (vh - h) / 2, w, h };
  }

  function roiNative() {
    if (!S.photo) return null;
    const b = bracketRect();
    const p0 = screenToNative(b.left, b.top);
    const p1 = screenToNative(b.left + b.w, b.top + b.h);
    const x = clamp(p0.x, 0, S.photo.w - 8);
    const y = clamp(p0.y, 0, S.photo.h - 8);
    return {
      x, y,
      w: clamp(p1.x - p0.x, 8, S.photo.w - x),
      h: clamp(p1.y - p0.y, 8, S.photo.h - y),
    };
  }

  /* ── tunnel di rettangoli prima dello zoom ─────────────────────────── */
  function nativeRectToScreen(r) {
    return {
      x: r.x * S.scale + S.tx,
      y: r.y * S.scale + S.ty,
      w: r.w * S.scale,
      h: r.h * S.scale,
    };
  }

  function runTunnel(nativeRect, rings = 5) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !nativeRect) return Promise.resolve();

    const layer = $("#tunnel");
    const { w: vw, h: vh } = vpSize();
    const t = nativeRectToScreen(nativeRect);
    layer.innerHTML = "";
    const els = [];

    for (let i = 0; i < rings; i++) {
      const k = rings === 1 ? 1 : i / (rings - 1);
      const e = k * k; // accelera verso il bersaglio
      // parte 14 px dentro il bordo, così il primo rettangolo si vede
      const x = lerp(14, t.x, e);
      const y = lerp(14, t.y, e);
      const w = lerp(vw - 28, t.w, e);
      const h = lerp(vh - 28, t.h, e);
      const el = document.createElement("div");
      el.className = "ring";
      el.style.left = x.toFixed(1) + "px";
      el.style.top = y.toFixed(1) + "px";
      el.style.width = Math.max(2, w).toFixed(1) + "px";
      el.style.height = Math.max(2, h).toFixed(1) + "px";
      layer.appendChild(el);
      els.push(el);
    }

    layer.classList.remove("fade");
    return new Promise((resolve) => {
      let i = 0;
      const STEP = 240; // il ritmo della macchina: un rettangolo ogni 240 ms
      const step = () => {
        if (i >= els.length) {
          // solo alla fine il tunnel si dissolve, tutto insieme
          setTimeout(() => {
            layer.classList.add("fade");
            setTimeout(() => {
              layer.innerHTML = "";
              layer.classList.remove("fade");
              resolve();
            }, 330);
          }, 180);
          return;
        }
        // resta acceso: il tunnel si costruisce rettangolo dopo rettangolo
        els[i].classList.add("lit");
        // ogni frame suona come il pull out
        playSfx("zoom", { rate: 0.92, vol: 0.8 });
        i++;
        setTimeout(step, STEP);
      };
      step();
    });
  }

  /* ── griglia di coordinate che si accende a immagine ferma ─────────── */
  let cgTimer = null;
  function pulseCoordGrid(ms = 4200) {
    const el = $("#coord-grid");
    if (!el) return;
    el.classList.add("on");
    updateHud();
    clearTimeout(cgTimer);
    cgTimer = setTimeout(() => el.classList.remove("on"), ms);
  }

  function paintGridLabels() {
    const box = $("#cg-labels");
    if (!box) return;
    box.innerHTML = `
      <span id="cg-x0" style="left:14px; top:9px"></span>
      <span id="cg-x1" style="right:14px; top:9px"></span>
      <span id="cg-y0" style="left:14px; bottom:9px"></span>
      <span id="cg-y1" style="right:14px; bottom:9px"></span>`;
  }

  /* ── prefetch: prepara il livello successivo mentre guardi il risultato ── */
  let prefetchToken = 0;
  async function maybePrefetch(rect, factor) {
    if (!S.photo || factor >= 8) return;
    const token = ++prefetchToken;
    const w = rect.w * 0.55;
    const h = rect.h * 0.55;
    const r2 = { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
    const f2 = clamp(factor * 2, 2, 16);

    await new Promise((r) => setTimeout(r, 650));
    if (token !== prefetchToken) return;
    try {
      const res = await fetch("/api/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: S.photo.id,
          x: r2.x, y: r2.y, w: r2.w, h: r2.h,
          out_w: Math.round(clamp(r2.w * f2, 256, 2400)),
          text: S.render === "text",
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (token !== prefetchToken) return;
      S.prefetch = { rect: r2, factor: f2, data, mode: S.render };
    } catch (_) { /* silenzio: è solo un'anticipazione */ }
  }

  function takePrefetch(rect) {
    const p = S.prefetch;
    if (!p || p.mode !== S.render) return null;
    const eps = 2.5;
    const inside =
      rect.x >= p.rect.x - eps &&
      rect.y >= p.rect.y - eps &&
      rect.x + rect.w <= p.rect.x + p.rect.w + eps &&
      rect.y + rect.h <= p.rect.y + p.rect.h + eps;
    if (!inside) return null;
    S.prefetch = null;
    return p.data;
  }

  /* ── HUD ───────────────────────────────────────────────────────────── */
  let hudRaf = 0;
  function updateHud() {
    if (hudRaf) return;
    hudRaf = requestAnimationFrame(() => {
      hudRaf = 0;
      const { w: vw, h: vh } = vpSize();
      const c = screenToNative(vw / 2, vh / 2);
      const zm = S.fitScale ? S.scale / S.fitScale : 1;
      const ew = S.photo ? c.x : 0;
      const ns = S.photo ? c.y : 0;

      $("#ro-mag").textContent = zm.toFixed(2) + "×";
      $("#ro-loc").textContent = pad4(ns) + " / " + pad4(ew);
      $("#ch-coord").textContent = `ZM ${pad4(zm * 1000)} NS ${fmtCoord(ns)} EW ${fmtCoord(ew)}`;
      $("#bc-zm").textContent = pad4(zm * 1000);
      $("#bc-mag").textContent = zm.toFixed(2) + "×";
      $("#bc-ns").textContent = fmtCoord(ns);
      $("#bc-ew").textContent = fmtCoord(ew);

      if (S.photo && $("#coord-grid").classList.contains("on")) {
        const sx = vw / S.scale, sy = vh / S.scale;
        const setL = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        setL("cg-x0", "EW " + fmtCoord(c.x - sx / 2));
        setL("cg-x1", "EW " + fmtCoord(c.x + sx / 2));
        setL("cg-y0", "NS " + fmtCoord(c.y - sy / 2));
        setL("cg-y1", "NS " + fmtCoord(c.y + sy / 2));
      }

      const marker = $("#scale-y-marker");
      const ro = $("#scale-y-readout");
      if (marker) {
        const pct = clamp(ns / (S.photo ? S.photo.h : 1), 0, 1) * 100;
        marker.style.top = pct + "%";
        readoutStyle(ro, pct, fmtCoord(ns));
      }

      setField("#in-zm", pad4(zm * 1000));
      setField("#in-ns", fmtCoord(ns));
      setField("#in-ew", fmtCoord(ew));

      if (S.photo) {
        const rn = roiNative();
        $("#bracket-tag").textContent = `ROI ${fmtCoord(rn.x)}–${fmtCoord(rn.x + rn.w)}`;
      }
      updateScaleStrip(vw, c.x);
      updateFidelity(zm);
      const plus = $("#plus");
      if (plus) plus.classList.toggle("on", S.render !== "pixel" && S.tiles.length > 0 && zm > 1.05);
    });
  }

  /** Numeri della barra in basso: pixel reali attorno al centro. */
  function updateScaleStrip(vw, cx) {
    if (!S.photo) return;
    const span = vw / S.scale;
    const raw = span / 3;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) || pow * 10;
    const start = Math.floor((cx - span / 2) / step) * step;
    const vals = [0, 1, 2, 3].map((i) => Math.max(0, Math.round(start + i * step)));
    $("#scale-strip").textContent = vals.map((v) => String(v).padStart(4, "0")).join(" ");
  }

  function readoutStyle(el, pct, text) {
    if (!el) return;
    el.textContent = text;
    el.style.top = pct + "%";
  }

  function updateFidelity(mag) {
    if (S.render === "text") {
      const lt = clamp(Math.log2(Math.max(mag, 0.25)), -2, 5);
      const pct = clamp(((lt + 2) / 7) * 100, 0, 100);
      $("#fid-fill").style.width = pct + "%";
      $("#fid-mark").style.left = clamp(((Math.log2(4) + 2) / 7) * 100, 0, 100) + "%";
      const nt = $("#fid-note");
      nt.textContent = "TEXT · TTA ×2 — letters reconstructed from the original";
      nt.style.color = "";
      $("#ro-mag").style.color = "";
      return;
    }
    if (S.render === "pixel") {
      $("#fid-fill").style.width = "0%";
      $("#fid-mark").style.left = "0%";
      const n0 = $("#fid-note");
      n0.textContent = "REAL PIXELS — no model, no invention";
      n0.style.color = "";
      $("#ro-mag").style.color = "";
      return;
    }
    const logv = clamp(Math.log2(Math.max(mag, 0.25)), -2, 5); // -2..5
    const pct = clamp(((logv + 2) / 7) * 100, 0, 100);
    $("#fid-fill").style.width = pct + "%";
    $("#fid-mark").style.left = pct + "%";

    let txt, warn = false;
    const realPx = S.photo ? Math.round(S.photo.w * S.photo.h) : 0;
    if (mag <= 2) {
      txt = `1 source pixel → ${mag.toFixed(2)} screen px · detail is real`;
    } else if (mag <= 4) {
      txt = `1 source pixel → ${mag.toFixed(2)} screen px · interpolated`;
    } else {
      warn = true;
      txt = `1 source pixel → ${mag.toFixed(2)} screen px · model is inventing texture`;
    }
    const note = $("#fid-note");
    note.textContent = txt;
    note.style.color = warn ? "var(--warn)" : "";
    if (S.photo) $("#ro-mag").style.color = warn ? "var(--warn)" : "";
  }

  /* ── tiles ─────────────────────────────────────────────────────────── */
  function addTile(rect, dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    img.draggable = false;
    img.style.left = rect[0] + "px";
    img.style.top = rect[1] + "px";
    img.style.width = (rect[2] - rect[0]) + "px";
    img.style.height = (rect[3] - rect[1]) + "px";
    tilesEl.appendChild(img);
    S.tiles.push({ rect, img, el: img });

    while (S.tiles.length > 12) {
      const old = S.tiles.shift();
      old.el.remove();
    }
    $("#sig-tiles").textContent = S.tiles.length;
  }

  /* ── enhance ───────────────────────────────────────────────────────── */
  async function enhance(rectOverride, opts = {}) {
    if (!S.photo || S.busy) return;
    const r = rectOverride || roiNative();
    if (!r) return;

    const factor = clamp(opts.factor || S.scale * 1.8, 1.2, 16);
    const outW = Math.round(clamp(r.w * factor, 256, 2400));

    // ── modalità PIXEL: si scende nei pixel reali, il modello resta spento ──
    if (S.render === "pixel") {
      S.busy = true;
      $("#big-coords").classList.add("hide");
      setStatus("PIXEL SCAN", "busy");
      playSfx("enhance");
      log("PIXEL ZOOM", `${Math.round(r.w)}×${Math.round(r.h)} · no model`);
      await runTunnel(r, 5);
      const vp = vpSize();
      const target = Math.min((vp.w * 0.92) / r.w, (vp.h * 0.92) / r.h);
      const sc = clamp(target, S.fitScale * 0.8, S.fitScale * 40);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      tweenView({ scale: sc, tx: vp.w / 2 - cx * sc, ty: vp.h / 2 - cy * sc }, 320);
      $("#hud-op").textContent = "NATIVE PIXELS";
      $("#hud-sub").textContent = "NO MODEL · NO INVENTION";
      setTimeout(() => {
        S.busy = false;
        $("#big-coords").classList.remove("hide");
        setStatus("ONLINE", "on");
      }, 380);
      return;
    }

    S.busy = true;
    $("#big-coords").classList.add("hide");
    setStatus("ENHANCING", "busy");
    $("#sig-mode").textContent = S.render === "text" ? "TEXT-TTA" : "REAL-ESRGAN-X4";
    playSfx("enhance");
    prefetchToken++; // gli anticipi vecchi non servono più

    const t0 = performance.now();
    let settled = false;
    const cached = takePrefetch(r);
    const fetchP = cached
      ? Promise.resolve(cached)
      : fetch("/api/enhance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: S.photo.id, x: r.x, y: r.y, w: r.w, h: r.h, out_w: outW, text: S.render === "text" }),
        }).then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
          return res.json();
        });
    fetchP.then(() => { settled = true; }, () => { settled = true; });

    // il tunnel copre l'attesa: rettangoli che scattano dal più grande al più piccolo
    await runTunnel(r, opts.rings || 5);

    // la macchina ha finito? se no, mostra il lavoro in corso
    if (!settled) {
      $("#busy").classList.add("on");
      $("#busy-title").textContent = opts.label || "ENHANCING";
      $("#busy-sub").textContent = `${Math.round(r.w)} × ${Math.round(r.h)} PX → ${outW} PX · ${factor.toFixed(1)}×`;
      $("#scanline").classList.remove("run");
      void $("#scanline").offsetWidth;
      $("#scanline").classList.add("run");
    }

    try {
      const data = await fetchP;
      const m = data.meta;
      addTile(m.rect, data.image);

      S.lastMeta = m;
      // prepara in silenzio il livello successivo (×2 sul centro)
      maybePrefetch(
        { x: m.rect[0], y: m.rect[1], w: m.rect[2] - m.rect[0], h: m.rect[3] - m.rect[1] },
        m.factor
      );
      $("#sig-mode").textContent = m.mode.toUpperCase();
      $("#sig-device").textContent = (m.device || "cpu").toUpperCase();
      $("#sig-last").textContent = (m.ms || Math.round(performance.now() - t0)) + " MS";
      $("#sig-out").textContent = `${m.out_w}×${m.out_h}`;
      $("#sig-passes").textContent = m.passes;
      $("#hud-op").textContent = "ENHANCE";
      $("#hud-sub").textContent = `${m.mode.toUpperCase()} · ${m.factor.toFixed(2)}× · ${m.out_w}×${m.out_h}`;
      log("ENHANCE", `${Math.round(r.w)}×${Math.round(r.h)} → ${m.out_w}×${m.out_h} · ${m.ms}ms${m.cache_hit ? " · cache" : ""}`);
      playSfx("zoom", { vol: 0.85 });

      if (opts.zoom !== false) {
        const { w: vw, h: vh } = vpSize();
        const rw = Math.max(4, m.rect[2] - m.rect[0]);
        const rh = Math.max(4, m.rect[3] - m.rect[1]);
        const target = Math.min((vw * 0.92) / rw, (vh * 0.92) / rh);
        // non superare il dettaglio realmente ricostruito (max 16×)
        const sc = clamp(target, S.fitScale * 0.8, S.fitScale * 16);
        const cx = m.rect[0] + rw / 2;
        const cy = m.rect[1] + rh / 2;
        tweenView({ scale: sc, tx: vw / 2 - cx * sc, ty: vh / 2 - cy * sc }, 340);
      }
    } catch (err) {
      setStatus("ERROR", "");
      log("ERROR", String(err.message || err));
      $("#hud-op").textContent = "FAULT";
      $("#hud-sub").textContent = String(err.message || err).toUpperCase().slice(0, 48);
      playSfx("fault");
    } finally {
      S.busy = false;
      $("#busy").classList.remove("on");
      $("#big-coords").classList.remove("hide");
      setStatus("ONLINE", "on");
    }
  }

  /* ── comandi di movimento ──────────────────────────────────────────── */
  function moveIn(f = 1.55) {
    if (!S.photo) return;
    pushHist();
    S.lastZoomDir = 1;
    const b = bracketRect();
    zoomAt(b.left + b.w / 2, b.top + b.h / 2, f);
    log("MOVE IN", `MAG ${(S.scale / S.fitScale).toFixed(2)}×`);
    playSfx("zoom", { rate: 1.08, vol: 0.8 });
  }

  function pullOut(f = 1.55) {
    if (!S.photo) return;
    pushHist();
    S.lastZoomDir = -1;
    const b = bracketRect();
    zoomAt(b.left + b.w / 2, b.top + b.h / 2, 1 / f);
    log("PULL OUT", `MAG ${(S.scale / S.fitScale).toFixed(2)}×`);
    playSfx("zoom", { rate: 0.92, vol: 0.8 });
  }

  function centerView() {
    if (!S.photo) return;
    pushHist();
    const { w: vw, h: vh } = vpSize();
    const c = centerNative();
    S.tx = vw / 2 - c.x * S.scale;
    S.ty = vh / 2 - c.y * S.scale;
    clampPan(); applyView();
    pulseCoordGrid(5600);   // +3s
    log("CENTER", `NS ${fmtCoord(c.y)} EW ${fmtCoord(c.x)}`);
    playSfx("select", { vol: 0.8 });
  }

  function track(dir, amountPct = 45) {
    if (!S.photo) return;
    pushHist();
    const { w: vw, h: vh } = vpSize();
    const dx = vw * (amountPct / 100);
    const dy = vh * (amountPct / 100);
    if (dir === "right") S.tx -= dx;
    if (dir === "left") S.tx += dx;
    if (dir === "down") S.ty -= dy;
    if (dir === "up") S.ty += dy;
    clampPan(); applyView();
    log(`TRACK ${amountPct} ${dir.toUpperCase()}`, "");
    playSfx("select", { vol: 0.7 });
  }

  function startMotion(dir) {
    pushHist();
    stopMotion();
    const speed = 0.55; // viewport al secondo
    const t0 = performance.now();
    let last = t0;
    const step = (t) => {
      const dt = (t - last) / 1000; last = t;
      const { w: vw, h: vh } = vpSize();
      const d = speed * Math.max(dt, 0.001);
      if (dir === "right") S.tx -= vw * d;
      if (dir === "left") S.tx += vw * d;
      if (dir === "down") S.ty -= vh * d;
      if (dir === "up") S.ty += vh * d;
      clampPan(); applyView();
      S.motion = requestAnimationFrame(step);
    };
    S.motion = requestAnimationFrame(step);
    log(`GO ${dir.toUpperCase()}`, "CONTINUOUS");
  }

  function stopMotion() {
    if (S.motion) {
      cancelAnimationFrame(S.motion);
      S.motion = null;
      log("STOP", "");
      playSfx("select", { vol: 0.5, rate: 0.9 });
      setStatus("ONLINE", "on");
    }
    S.holdDir = 0;
  }

  /* Zoom continuo: il punto sotto il mirino è un PIXEL REALE e resta fermo
     mentre la scala cambia. Si ferma con STOP (o ai limiti reali). */
  function startZoomHold(dir = 1) {
    if (!S.photo) return;
    stopMotion();
    pushHist();
    S.lastZoomDir = dir;

    const b = bracketRect();
    const ax = b.left + b.w / 2;        // ancora sullo schermo
    const ay = b.top + b.h / 2;
    const nx = (ax - S.tx) / S.scale;   // ← coordinate native reali
    const ny = (ay - S.ty) / S.scale;
    const minS = S.fitScale * 0.6;
    const maxS = Math.max(S.fitScale * 40, 24);
    const RATE = 0.7;                   // raddoppia ogni ~1 secondo
    let last = performance.now();
    let logged1 = false;

    const step = (t) => {
      // il timestamp del primo frame può precedere performance.now(): mai dt < 0
      const dt = clamp((t - last) / 1000, 0.001, 0.12);
      last = t;
      const next = clamp(S.scale * Math.exp(dir * RATE * dt), minS, maxS);
      if (next === S.scale) {
        S.motion = null;
        S.holdDir = 0;
        log("HOLD", "LIMIT REACHED");
        setStatus("ONLINE", "on");
        playSfx("fault", { vol: 0.35 });
        return;
      }
      S.scale = next;
      S.tx = ax - nx * next;            // il pixel reale resta sotto il mirino
      S.ty = ay - ny * next;
      clampPan();
      applyView();
      if (!logged1 && Math.abs(next - 1) < 0.02) {
        logged1 = true;
        log("1:1", `NATIVE PIXEL SCALE · EW ${fmtCoord(nx)} NS ${fmtCoord(ny)}`);
      }
      S.motion = requestAnimationFrame(step);
    };

    S.holdDir = dir;
    S.motion = requestAnimationFrame(step);
    setStatus(dir > 0 ? "HOLD IN" : "HOLD OUT", "busy");
    log(dir > 0 ? "HOLD IN" : "HOLD OUT", `ANCHOR EW ${fmtCoord(nx)} NS ${fmtCoord(ny)}`);
    playSfx("zoom", { rate: dir > 0 ? 1.08 : 0.92, vol: 0.8 });
  }

  function toggleHold() {
    if (S.motion) { stopMotion(); return; }
    startZoomHold(S.lastZoomDir || 1);
  }

  /* ── range numerico stile film ─────────────────────────────────────── */
  function enhanceRange(a, b, label) {
    // Coordinate sbagliate non devono passare in silenzio: il clamp le
    // trasformerebbe in una fascia plausibile ma non richiesta. Meglio un
    // rifiuto rumoroso — il suono d'errore è parte del feedback.
    if (!S.photo) {
      playSfx("fault", { vol: 0.5 });
      log("ENHANCE", "NESSUNA LASTRA NEL LETTO");
      setVoiceNote("Nessuna lastra: inserisci una fotografia.");
      return false;
    }
    const W = S.photo.w;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > W) {
      playSfx("fault", { vol: 0.55 });
      log("ENHANCE", `RANGE ${a} → ${b} · FUORI LASTRA (0–${W})`);
      setVoiceNote(`Coordinate fuori dalla lastra: 0–${W}.`);
      return false;
    }
    if (hi - lo < 2) {
      playSfx("fault", { vol: 0.55 });
      log("ENHANCE", `FASCIA NULLA (${hi - lo} px)`);
      setVoiceNote("Fascia troppo stretta: almeno 2 pixel.");
      return false;
    }
    pushHist();
    // le unità sono PIXEL dell'immagine originale
    const x1 = lo;
    const x2 = hi;
    const w = Math.max(8, x2 - x1);
    const { w: vw, h: vh } = vpSize();
    const h = clamp(w * (vh / vw), 8, S.photo.h);
    const c = centerNative();
    const y = clamp(c.y - h / 2, 0, S.photo.h - h);
    log(`ENHANCE ${a} TO ${b}`, label || "");
    enhance({ x: x1, y, w, h }, { factor: clamp(vw / w, 1.5, 8), label: `ENHANCE ${a} TO ${b}` });
    return true;
  }

  /* ── coordinata manuale ────────────────────────────────────────────── */
  function goToCoords() {
    if (!S.photo) return;
    pushHist();
    const zm = clamp(parseInt($("#in-zm").value || "1000", 10), 1, 9999);
    const ns = clamp(parseFloat($("#in-ns").value || "0"), 0, S.photo.h);
    const ew = clamp(parseFloat($("#in-ew").value || "0"), 0, S.photo.w);
    const { w: vw, h: vh } = vpSize();
    const sc = clamp(S.fitScale * (zm / 1000), S.fitScale * 0.6, Math.max(S.fitScale * 40, 24));
    const nx = ew;
    const ny = ns;
    tweenView({ scale: sc, tx: vw / 2 - nx * sc, ty: vh / 2 - ny * sc }, 300);
    log("GOTO", `ZM ${pad4(zm)} NS ${pad4(ns)} EW ${pad4(ew)}`);
  }

  /* ── hard copy ─────────────────────────────────────────────────────── */
  async function hardCopy() {
    if (!S.photo) return;
    const { w: vw, h: vh } = vpSize();
    const k = 2;
    const W = Math.round(vw * k), H = Math.round(vh * k);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");

    ctx.fillStyle = "#020505";
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.setTransform(S.scale * k, 0, 0, S.scale * k, S.tx * k, S.ty * k);
    try { ctx.drawImage(base, 0, 0, S.photo.w, S.photo.h); } catch (_) {}
    for (const t of S.tiles) {
      if (!t.img.complete) { try { await t.img.decode(); } catch (_) {} }
      const [x1, y1, x2, y2] = t.rect;
      try { ctx.drawImage(t.img, x1, y1, x2 - x1, y2 - y1); } catch (_) {}
    }
    ctx.restore();

    // ── banda di stampa: cornice e metadati ──
    const m = S.lastMeta;
    const zm = S.scale / S.fitScale;
    const TOP = 74, BOT = 78;

    ctx.fillStyle = "rgba(1, 5, 6, 0.9)";
    ctx.fillRect(0, 0, W, TOP);
    ctx.fillRect(0, H - BOT, W, BOT);

    ctx.strokeStyle = "rgba(157,246,255,0.65)";
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, TOP); ctx.lineTo(W, TOP);
    ctx.moveTo(0, H - BOT); ctx.lineTo(W, H - BOT);
    ctx.stroke();

    // testata
    ctx.fillStyle = "rgba(217,252,255,0.95)";
    ctx.font = "600 24px ui-monospace, Menlo, monospace";
    ctx.fillText("ESPER / PHOTO ANALYSIS", 30, 40);
    ctx.font = "14px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(157,246,255,0.7)";
    ctx.fillText("TYRELL CORP. · MODEL 5 · HARD COPY", 30, 60);

    // coordinate in testata a destra
    ctx.textAlign = "right";
    ctx.font = "13px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(157,246,255,0.85)";
    ctx.fillText(`ZM ${pad4(zm * 1000)}  NS ${fmtCoord(centerNative().y)}  EW ${fmtCoord(centerNative().x)}`, W - 30, 40);
    ctx.fillStyle = "rgba(157,246,255,0.55)";
    ctx.fillText(new Date().toISOString().replace("T", " ").slice(0, 19), W - 30, 60);
    ctx.textAlign = "left";

    // metadati in basso
    const lines = [
      `FILE  ${S.photo.name}`,
      `SRC   ${S.photo.w} × ${S.photo.h}     MAG ${zm.toFixed(2)}×     ${m ? m.mode.toUpperCase() + " · " + m.passes + " PASS" : "ORIGINAL"}`,
    ];
    ctx.font = "14px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(157,246,255,0.8)";
    lines.forEach((l, i) => ctx.fillText(l, 30, H - BOT + 30 + i * 22));

    // scala numerica a destra
    const a = Math.max(0, Math.round(centerNative().x) - 500);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(157,246,255,0.5)";
    ctx.font = "13px ui-monospace, Menlo, monospace";
    ctx.fillText([a, a + 500, a + 1000].map((v) => String(v).padStart(5, "0")).join("  "), W - 30, H - 22);
    ctx.textAlign = "left";

    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const a2 = document.createElement("a");
    a2.href = URL.createObjectURL(blob);
    a2.download = `esper_hardcopy_${stamp}.png`;
    a2.click();
    setTimeout(() => URL.revokeObjectURL(a2.href), 5000);
    log("HARD COPY", `PRINTED ${W}×${H}`);
    playSfx("shutter");
  }

  /* ── parsing numerico vocale ───────────────────────────────────────── */
  const EN_UNITS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const IT_UNITS = {
    zero: 0, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
    dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16,
    diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, trenta: 30, quaranta: 40,
    cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  };

  function chunkToNumber(words) {
    // forma "militare": "one seventy six" → 176, "two twenty four" → 224
    if (words.length >= 2) {
      const first = words[0] in EN_UNITS ? EN_UNITS[words[0]] : (words[0] in IT_UNITS ? IT_UNITS[words[0]] : null);
      const second = words[1] in EN_UNITS ? EN_UNITS[words[1]] : (words[1] in IT_UNITS ? IT_UNITS[words[1]] : null);
      if (first !== null && first >= 1 && first <= 9 && second !== null && second >= 20 && second <= 99) {
        const rest = chunkToNumber(words.slice(1));
        if (rest !== null) return first * 100 + rest;
      }
    }

    let total = 0, current = 0, consumed = false;
    for (const w of words) {
      if (w in EN_UNITS) { current += EN_UNITS[w]; consumed = true; }
      else if (w in IT_UNITS) { current += IT_UNITS[w]; consumed = true; }
      else if (w === "hundred" || w === "cento") { current = (current || 1) * 100; consumed = true; }
      else if (w === "thousand" || w === "mille") { total += (current || 1) * 1000; current = 0; consumed = true; }
      else if (w === "and" || w === "e") { /* connettivo */ }
      else return null;
    }
    return consumed ? total + current : null;
  }

  /** Sostituisce le parole-numero con cifre: "forty five right" → "45 right". */
  function digitize(text) {
    const tokens = text.toLowerCase()
      .replace(/[.,;:!?]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const out = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      // prova a leggere come numero composto
      const n = chunkToNumber(buf);
      if (n !== null) { out.push(String(n)); buf = []; return; }
      // cifre singole in sequenza: "two two four" → 224
      if (buf.every((w) => /^\d+$/.test(w) || (w in EN_UNITS && EN_UNITS[w] < 10))) {
        out.push(buf.map((w) => (/^\d+$/.test(w) ? w : String(EN_UNITS[w]))).join(""));
      } else {
        out.push(...buf);
      }
      buf = [];
    };
    for (const tk of tokens) {
      if (/^\d+$/.test(tk)) { flush(); out.push(tk); }
      else if (tk in EN_UNITS || tk in IT_UNITS || ["hundred", "thousand", "cento", "mille"].includes(tk)) buf.push(tk);
      else { flush(); out.push(tk); }
    }
    flush();
    return out.join(" ");
  }

  /* ── normalizzazione fonetica ──────────────────────────────────────────
     Il recognizer sbaglia sempre le stesse parole: "enhance" diventa "hands",
     "track left" diventa "tracklist". Correggiamo prima del parser.            */
  const PHONETIC = {
    HANDS: "ENHANCE", HAND: "ENHANCE", HAN: "ENHANCE", HUN: "ENHANCE", ENHANCER: "ENHANCE",
    TRACKLIST: "TRACK LEFT", TRACKLISTE: "TRACK LEFT", TRACKLISTA: "TRACK LEFT", TRACKLISTI: "TRACK LEFT", PENLIST: "TRACK LEFT",
    PANELIST: "TRACK LEFT", PALETTE: "TRACK LEFT", PALATE: "TRACK LEFT",
    TRACKRITE: "TRACK RIGHT", TRACKRIGHT: "TRACK RIGHT", PENRITE: "TRACK RIGHT",
    LIFT: "LEFT", RITE: "RIGHT", WRIGHT: "RIGHT", WRITE: "RIGHT",
    HOLDON: "HOLD", HOLDING: "HOLD", CONTINO: "CONTINUO", CONTINUOS: "CONTINUOUS",
    POOL: "PULL", PULLING: "PULL", COOLING: "PULL", COOLIN: "PULL",
    CENTOR: "CENTER", CENTA: "CENTER", SENT: "CENTER", SANTA: "CENTER",
    MOVIN: "MOVE IN", MOVING: "MOVE IN", MOVEIN: "MOVE IN", MOVEN: "MOVE IN",
    ZOOMIN: "ZOOM IN", ZOOMOUT: "ZOOM OUT", POLLOUT: "PULL OUT", PULLOUT: "PULL OUT",
    HARTCOPY: "HARD COPY", HARDCOPY: "HARD COPY", ARTCOPY: "HARD COPY", HARDCOPI: "HARD COPY",
    STAMPAMI: "STAMPA", STAMPALO: "STAMPA", PRINTING: "PRINT",
    GOBACK: "GO BACK", GOBECK: "GO BACK", FERMATI: "STOP", FERMATEVI: "STOP",
    RESETT: "RESET", RICOMINCIA: "RESET", AZZERRA: "AZZERA",
    EJET: "EJECT", EGET: "EJECT", IJECT: "EJECT", EJECTT: "EJECT",
    ENANS: "ENHANCE", ENHANS: "ENHANCE", ENHACE: "ENHANCE", ENHAND: "ENHANCE",
    ANALYZE: "ANALIZZA", ANALYSE: "ANALIZZA", ANALYSIS: "ANALIZZA", ANALIZA: "ANALIZZA",
    TUTORIAL: "TUTORIAL", TUTORIALE: "TUTORIAL", MANUALE: "MANUALE",
    GOWN: "DOWN", DAWN: "DOWN", BROWN: "DOWN",
  };
  function denoise(text) {
    return text.split(/\s+/).map((w) => PHONETIC[w] || w).join(" ");
  }

  /* ── motore dei comandi: sinonimi + tolleranza agli errori ────────────
     Il recognizer non restituisce quasi mai le parole esatte ("enhance" →
     "hands", "track left" → "tracklist", "avvicina" → "avicina"). Ogni
     comando ha quindi più modi di essere detto, e il confronto è per
     similarità di Levenshtein su parole intere: non serve la frase perfetta. */
  const VOICE_SIMPLE = [
    ["enhance", ["enhance", "analizza", "analisa", "analisi", "analysis", "analyze", "analyse", "esamina", "migliora", "ingrandisci", "scansiona", "metti a fuoco", "focus",
                 "hands", "and hands", "enhands", "enans", "enhans", "enhace", "enhange",
                 "in ance", "in ange", "in anze", "in ans", "in hands", "e in anze", "en ance"]],
    ["movein", ["move in", "zoom in", "avvicina", "avvicinati", "piu vicino", "piu grande", "verso dentro", "zoomin", "movein"]],
    ["pullout", ["pull out", "pull back", "zoom out", "allontana", "piu lontano", "piu piccolo", "verso fuori", "zoomout", "pullout"]],
    ["hold", ["hold", "continua", "continuo", "continue", "continuous", "continuously", "prosegui", "vai avanti", "keep going", "keep zooming", "non fermarti", "senza fermarsi", "zoom continuo", "continuous zoom"]],
    ["holdin", ["hold in", "zoom in continuo", "continuous zoom in", "avvicina continuo", "zoom continuo avanti"]],
    ["holdout", ["hold out", "zoom out continuo", "continuous zoom out", "allontana continuo", "zoom continuo indietro"]],
    ["stop", ["stop", "halt", "ferma", "fermati", "basta", "stop it"]],
    ["center", ["center", "centra", "centralo", "al centro"]],
    ["trackleft", ["track left", "sinistra", "a sinistra", "sposta a sinistra", "trackleft", "tracklista", "tracklist"]],
    ["trackright", ["track right", "destra", "a destra", "sposta a destra", "trackright", "trackrite"]],
    ["trackup", ["track up", "in alto", "sali", "verso l alto", "trackup"]],
    ["trackdown", ["track down", "in basso", "scendi", "verso il basso", "trackdown"]],
    ["hardcopy", ["hard copy", "print", "stampa", "salva", "copia", "esporta", "screenshot", "hardcopy"]],
    ["reset", ["reset", "azzera", "pulisci", "ripristina", "ricomincia"]],
    ["goback", ["go back", "annulla", "indietro", "undo", "torna"]],
    ["tutorial", ["tutorial", "help", "aiuto", "manuale", "guida"]],
    ["eject", ["eject", "espelli", "estrai", "cambia foto", "nuova foto", "cambia immagine", "rimuovi foto", "togli la foto", "next photo", "load another"]],
    ["theme_amber", ["tema ambra", "ambra", "theme amber", "amber theme", "phosphor amber"]],
    ["theme_green", ["tema verde", "verde", "theme green", "green theme", "phosphor green"]],
    ["theme_red", ["tema rosso", "rosso", "theme red", "red theme"]],
    ["theme_blue", ["tema blu", "blu", "theme blue", "blue theme"]],
    ["theme_chromo", ["tema ciano", "ciano", "theme cyan", "cyan theme", "tema originale"]],
    ["theme_next", ["cambia tema", "prossimo tema", "next theme"]],
    ["filter_ir", ["infrarosso", "infrared", "filtro infrarosso", "raggi infrarossi"]],
    ["filter_thermal", ["termico", "thermal", "filtro termico", "mappa termica"]],
    ["filter_natural", ["naturale", "natural", "colori veri", "filtro naturale"]],
    ["filter_chromo", ["cromo", "chromo", "ciano", "fosforo"]],
  ];

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function similarity(a, b) {
    return 1 - lev(a, b) / Math.max(a.length, b.length, 1);
  }

  /** Il comando più probabile contenuto in una frase, o null. */
  function fuzzyCommand(text) {
    const words = String(text).toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // "più" → "piu"
      .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    let best = null;
    for (const [id, phrases] of VOICE_SIMPLE) {
      for (const phrase of phrases) {
        const pw = phrase.split(" ");
        for (let i = 0; i + pw.length <= words.length; i++) {
          const win = words.slice(i, i + pw.length).join(" ");
          // un numero nella trascrizione non deve mai sposare una frase senza numeri
          if (/\d/.test(win) && !/\d/.test(phrase)) continue;
          let score = similarity(win, phrase);
          // una parola corta ("up") non deve battere una frase ("pull out")
          if (pw.length === 1 && phrase.length <= 3) score -= 0.05;
          // a parità vince la frase più specifica: "hold in" prima di "hold"
          if (!best || score > best.score + 1e-9 ||
              (Math.abs(score - best.score) < 1e-9 && pw.length > best.words)) {
            best = { id, score, phrase: win, words: pw.length };
          }
        }
      }
    }
    if (!best) return null;
    const needed = best.phrase.split(" ").length <= 1 ? 0.85 : 0.74;
    if (best.score < needed) return null;
    // allucinazione tipica: frase lunga in cui una sola parola somiglia a un
    // comando. Se il match copre poco del testo, non è un comando: è rumore.
    if (words.length >= 4 && best.words / words.length < 0.34 && best.score < 0.95) return null;
    return best;
  }

  /* ── cronologia: "go back" inverte l'ultima mossa ───────────────────── */
  const hist = [];
  function pushHist() {
    if (!S.photo) return;
    hist.push({ scale: S.scale, tx: S.tx, ty: S.ty });
    if (hist.length > 40) hist.shift();
  }
  function goBack() {
    const h = hist.pop();
    if (!h) { playSfx("fault"); log("BACK", "NOTHING TO UNDO"); return false; }
    tweenView(h, 280);
    log("BACK", `MAG ${(h.scale / S.fitScale).toFixed(2)}×`);
    playSfx("select", { vol: 0.7, rate: 1.1 });
    return true;
  }

  /* ── dispatcher comandi ────────────────────────────────────────────── */
  function handleCommand(raw) {
    const text = denoise(digitize(raw).toUpperCase()).trim();
    if (!text) return false;
    $("#voice-text").textContent = text;

    let m;
    if ((m = text.match(/(?:ENHANCE|MIGLIORA|ANALIZZA|ANALIZA|ANALYZE|ANALYSE|INGRANDISCI|ESAMINA|SCANSIONA)\s+(?:DA\s+)?(?:TO\s+)?(\d{1,4})\s*(?:ALLA|FINO\s+A|TO|A|2)\s*(\d{1,4})/))) {
      enhanceRange(+m[1], +m[2], "VOICE");
      return true;
    }
    if (/\b(ENHANCE|MIGLIORA|INGRANDISCI|AUMENTA|ANALIZZA|ANALIZA|ANALYZE|ANALYSE|ANALYSIS|SCAN)\b/.test(text)) {
      enhance(null, { label: "ENHANCE" });
      return true;
    }
    if ((m = text.match(/TRACK\s*(\d{1,3})?\s*(RIGHT|LEFT|UP|DOWN|DESTRA|SINISTRA|ALTO|BASSO)/))) {
      const dirMap = { RIGHT: "right", DESTRA: "right", LEFT: "left", SINISTRA: "left", UP: "up", ALTO: "up", DOWN: "down", BASSO: "down" };
      track(dirMap[m[2]], m[1] ? clamp(+m[1], 1, 200) : 45);
      return true;
    }
    if (/^GO\s+(RIGHT|LEFT|UP|DOWN)$/.test(text)) {
      const dir = /RIGHT/.test(text) ? "right" : /LEFT/.test(text) ? "left" : /UP/.test(text) ? "up" : "down";
      startMotion(dir);
      return true;
    }
    if (/^(VAI\s+)?(DESTRA|SINISTRA|SU|GIU)$/.test(text)) {
      const dir = /DESTRA/.test(text) ? "right" : /SINISTRA/.test(text) ? "left" : /^SU$/.test(text) ? "up" : "down";
      startMotion(dir);
      return true;
    }
    if (/\b(STOP|HALT|FERMATI|FERMA|BASTA)\b/.test(text)) { stopMotion(); return true; }
    // HOLD: "il comando che non si ferma da solo" — detto in molti modi, in due lingue.
    if (/\b(HOLD OUT|ZOOM OUT CONTINUO|CONTINUOUS ZOOM OUT|ALLONTANA CONTINUO|ZOOM CONTINUO INDIETRO|ZOOM INDIETRO CONTINUO)\b/.test(text)) { startZoomHold(-1); return true; }
    if (/\b(HOLD IN|ZOOM IN CONTINUO|CONTINUOUS ZOOM IN|AVVICINA CONTINUO|ZOOM CONTINUO AVANTI|ZOOM AVANTI CONTINUO)\b/.test(text)) { startZoomHold(1); return true; }
    if (/\b(HOLD|CONTINUA|CONTINUO|CONTINUE|CONTINUOUS|CONTINUOUSLY|KEEP GOING|KEEP ZOOMING|PROSEGUI|NON FERMARTI|SENZA FERMARSI|ZOOM CONTINUO|CONTINUOUS ZOOM|ZOOM PERPETUO)\b/.test(text)) { startZoomHold(S.lastZoomDir || 1); return true; }
    if (/\b(MOVE IN|AVVICINA|ZOOM IN|PIU VICINO)\b/.test(text)) { moveIn(); return true; }
    if (/\b(PULL (OUT|BACK)|ALLONTANA|ZOOM OUT)\b/.test(text)) { pullOut(); return true; }
    if (/\b(GO BACK|BACK|INDIETRO UN PASSO|ANNULLA|UNDO)\b/.test(text)) { return goBack() || true; }
    if (/\b(CENTER|CENTRA|CENTRALO)\b/.test(text)) { centerView(); return true; }
    if (/\b(TUTORIAL|HELP|MANUAL|MANUALE|GUIDA|AIUTO)\b/.test(text)) { toggleTutorial(); return true; }
    if (/\b(HARD COPY|PRINT|STAMPA|COPIA)\b/.test(text)) { hardCopy(); return true; }
    if (/\b(RESET|AZZERA|PULISCI)\b/.test(text)) { resetView(); return true; }

    if ((m = text.match(/\b(?:FILTER|FILTRO)\s+(INFRARED|INFRAROSSO|THERMAL|TERMICO|NATURAL|NATURALE|CROMO|CHROMO)\b/))
        || (m = text.match(/^(INFRARED|INFRAROSSO|THERMAL|TERMICO|NATURALE|CROMO)$/))) {
      const w = (m[1] || text).toUpperCase();
      setFilter(/INFRARED|INFRAROSSO/.test(w) ? "ir"
        : /THERMAL|TERMICO/.test(w) ? "thermal"
        : /NATURAL|NATURALE/.test(w) ? "natural" : "chromo",
        { source: "VOICE", text: raw });
      return true;
    }
    // ultima rete: sinonimi e tolleranza fonetica sulle parole di comando
    const fuzzy = fuzzyCommand(text);
    if (fuzzy) {
      const run = {
        enhance: () => enhance(null, { label: "ENHANCE" }),
        movein: () => moveIn(),
        pullout: () => pullOut(),
        hold: () => startZoomHold(S.lastZoomDir || 1),
        holdin: () => startZoomHold(1),
        holdout: () => startZoomHold(-1),
        stop: () => stopMotion(),
        center: () => centerView(),
        trackleft: () => track("left", 45),
        trackright: () => track("right", 45),
        trackup: () => track("up", 45),
        trackdown: () => track("down", 45),
        hardcopy: () => hardCopy(),
        reset: () => resetView(),
        goback: () => goBack(),
        tutorial: () => toggleTutorial(),
        eject: () => ejectFrame(),
        theme_amber: () => setTheme("amber"),
        theme_green: () => setTheme("green"),
        theme_red: () => setTheme("red"),
        theme_blue: () => setTheme("blue"),
        theme_chromo: () => setTheme("chromo"),
        theme_next: () => cycleTheme(),
        filter_ir: () => setFilter("ir", { source: "VOICE", text: raw }),
        filter_thermal: () => setFilter("thermal", { source: "VOICE", text: raw }),
        filter_natural: () => setFilter("natural", { source: "VOICE", text: raw }),
        filter_chromo: () => setFilter("chromo", { source: "VOICE", text: raw }),
      }[fuzzy.id];
      if (run) {
        const CMD_LABEL = {
          enhance: "ENHANCE", movein: "MOVE IN", pullout: "PULL OUT", hold: "HOLD",
          holdin: "HOLD IN", holdout: "HOLD OUT",
          stop: "STOP", center: "CENTER", trackleft: "TRACK LEFT", trackright: "TRACK RIGHT",
          trackup: "TRACK UP", trackdown: "TRACK DOWN", hardcopy: "HARD COPY",
          reset: "RESET", goback: "GO BACK", tutorial: "TUTORIAL", eject: "EJECT",
          theme_amber: "THEME AMBRA", theme_green: "THEME VERDE", theme_red: "THEME ROSSO",
          theme_blue: "THEME BLU", theme_chromo: "THEME CIANO", theme_next: "THEME NEXT",
          filter_ir: "FILTER IR", filter_thermal: "FILTER TERMICO",
          filter_natural: "FILTER NATURALE", filter_chromo: "FILTER CROMO",
        };
        $("#voice-text").textContent =
          text + "  →  " + (CMD_LABEL[fuzzy.id] || fuzzy.id.toUpperCase()) + " · " + Math.round(fuzzy.score * 100) + "%";
        run();
        return true;
      }
    }

    $("#voice-note").textContent = "Comando non riconosciuto. Prova: ENHANCE 224 TO 176, MOVE IN, TRACK 45 RIGHT, HARD COPY.";
    return false;
  }

  /* ── voce ──────────────────────────────────────────────────────────── */
  let rec = null, listening = false, wantListen = false;
  let micStream = null, analyser = null, levelRAF = 0, audioCtx = null;

  function setVoiceNote(t) { $("#voice-note").textContent = t; }

  /* ── voce locale: whisper.cpp sul Mac ──────────────────────────────────
     Il browser registra, il server trascrive, il parser esegue: l'audio non
     lascia la macchina. MediaRecorder riarma un segmento a ogni pausa — si
     parla, si tace un attimo, e il comando parte. */
  // Whisper allucina sui segmenti non vocali: frasi di cortesia, sottotitoli,
  // "Amara.org". Se una di queste arriva al parser, può somigliare a un comando.
  const HALLUCINATION = [
    /sottotitoli/i, /amara\.?org/i, /thank you/i, /thanks for watching/i,
    /grazie per aver/i, /subscribe/i, /transcri(bed|ption)/i,
    /^[\s.,!?…-]*$/, /^bye$/i, /^ciao$/i, /^musica$/i, /^\(.*\)$/,
  ];

  const LV = {
    stream: null, ctx: null, analyser: null, recorder: null, chunks: [],
    vadRAF: 0, speaking: false, lastVoice: 0, startedAt: 0, busy: false, skip: false,
  };

  function micMime() {
    if (!window.MediaRecorder) return "";
    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
    return "";
  }

  function armSegment() {
    if (!LV.stream || !wantListen) return;
    const mime = micMime();
    LV.chunks = [];
    LV.peak = 0;
    LV.recorder = mime ? new MediaRecorder(LV.stream, { mimeType: mime }) : new MediaRecorder(LV.stream);
    LV.recorder.ondataavailable = (e) => { if (e.data && e.data.size) LV.chunks.push(e.data); };
    LV.recorder.onstop = async () => {
      const type = (LV.recorder && LV.recorder.mimeType) || mime || "audio/webm";
      const blob = new Blob(LV.chunks, { type });
      const dur = performance.now() - LV.startedAt;
      const skip = LV.skip;
      LV.skip = false;
      LV.chunks = [];
      // serve energia vera: un fruscio non deve diventare un comando
      if (!skip && blob.size > 3000 && dur > 600 && LV.peak > 0.03) await sendVoice(blob);
      if (wantListen) armSegment();
    };
    LV.recorder.start();
    LV.startedAt = performance.now();
  }

  async function sendVoice(blob) {
    if (LV.busy) return;
    LV.busy = true;
    setStatus("THINKING", "busy");
    try {
      const lang = ($("#sel-lang").value || "it").startsWith("it") ? "it" : "en";
      const fd = new FormData();
      fd.append("audio", blob, "voice.webm");
      const res = await fetch("/api/voice?lang=" + lang, { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const data = await res.json();
      const text = (data.text || "").trim();
      if (!text || text.length < 3 || HALLUCINATION.some((re) => re.test(text))) {
        if (text) log("VOICE", `SCARTATO «${text.toUpperCase().slice(0, 40)}»`);
        return;
      }
      if (text) {
        $("#voice-text").textContent = text.toUpperCase() + "  ·  " + data.ms + " ms";
        if (!handleCommand(text)) setVoiceNote('Sentito: "' + text + '" — comando non riconosciuto.');
      }
    } catch (err) {
      setVoiceNote("Whisper: " + (err.message || err));
      playSfx("fault", { vol: 0.5 });
    } finally {
      LV.busy = false;
      if (wantListen) setStatus("LISTENING", "on");
    }
  }

  function runVad() {
    const buf = new Float32Array(LV.analyser.fftSize);
    const tick = () => {
      if (!wantListen || !LV.analyser) return;
      LV.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      $("#voice-level").style.width = clamp(rms * 900, 0, 100) + "%";
      const now = performance.now();
      LV.peak = Math.max(LV.peak, rms);
      if (rms > 0.018) {
        LV.lastVoice = now;
        LV.speaking = true;
      } else if (LV.speaking && now - LV.lastVoice > 650) {
        LV.speaking = false;
        try { if (LV.recorder && LV.recorder.state === "recording") LV.recorder.stop(); } catch (_) {}
      }
      // sicurezza: segmento troppo lungo → chiudi e invia
      if (LV.speaking && LV.recorder && LV.recorder.state === "recording" && now - LV.startedAt > 9000) {
        LV.speaking = false;
        try { LV.recorder.stop(); } catch (_) {}
      }
      // silenzio prolungato: scarta il segmento e riarma (non far crescere il buffer)
      if (!LV.speaking && LV.recorder && LV.recorder.state === "recording" && now - LV.startedAt > 12000) {
        LV.skip = true;
        try { LV.recorder.stop(); } catch (_) {}
      }
      LV.vadRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  async function startLocalVoice() {
    wantListen = true;
    try {
      LV.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      wantListen = false;
      setVoiceNote("Microfono non accessibile: " + (e.message || e));
      playSfx("fault");
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    LV.ctx = new AC();
    const src = LV.ctx.createMediaStreamSource(LV.stream);
    LV.analyser = LV.ctx.createAnalyser();
    LV.analyser.fftSize = 1024;
    src.connect(LV.analyser);

    $("#btn-mic").classList.add("on");
    setStatus("LISTENING", "on");
    setVoiceNote("In ascolto — whisper locale. Parla, poi taci un istante.");
    armSegment();
    runVad();
  }

  function stopLocalVoice() {
    wantListen = false;
    if (LV.vadRAF) cancelAnimationFrame(LV.vadRAF);
    LV.vadRAF = 0;
    LV.speaking = false;
    try { if (LV.recorder && LV.recorder.state !== "inactive") LV.recorder.stop(); } catch (_) {}
    LV.recorder = null;
    if (LV.stream) { LV.stream.getTracks().forEach((t) => t.stop()); LV.stream = null; }
    if (LV.ctx) { try { LV.ctx.close(); } catch (_) {} LV.ctx = null; }
    LV.analyser = null;
    $("#btn-mic").classList.remove("on");
    $("#voice-level").style.width = "0%";
    setStatus("ONLINE", "on");
    setVoiceNote("Mic off (whisper locale). I comandi manuali restano attivi.");
  }

  async function startVoice() {
    if (S.whisper) { await startLocalVoice(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setVoiceNote("Questo browser non espone la Web Speech API. Usa Chrome o Safari, oppure i comandi manuali.");
      return;
    }
    wantListen = true;
    if (!rec) {
      rec = new SR();
      rec.continuous = true;
      const GRAMMAR = "#JSGF V1.0; grammar esper; public <cmd> = enhance | \"move in\" | \"pull out\" | \"zoom in\" | \"zoom out\" | stop | hold | \"go back\" | \"hard copy\" | print | track | center | reset | left | right | up | down | \"track left\" | \"track right\" | \"track up\" | \"track down\" | \"filter infrared\" | \"filter thermal\" | \"filter natural\" | \"filter chromo\" | tutorial | help;";
      const GL = window.SpeechGrammarList || window.webkitSpeechGrammarList;
      if (GL) { try { const gl = new GL(); gl.addFromString(GRAMMAR, 1); rec.grammars = gl; } catch (_) {} }
      rec.interimResults = true;
      rec.maxAlternatives = 6;
      rec.onstart = () => {
        listening = true;
        $("#btn-mic").classList.add("on");
        setStatus("LISTENING", "on");
        setVoiceNote("In ascolto. Parla come Deckard.");
      };
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) {
            // il recognizer offre quattro interpretazioni: provale tutte
            for (let k = 0; k < res.length; k++) {
              if (res[k].transcript && handleCommand(res[k].transcript)) break;
            }
          } else {
            interim += res[0].transcript;
          }
        }
        if (interim) $("#voice-text").textContent = interim.toUpperCase();
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed") {
          wantListen = false;
          setVoiceNote("Permesso microfono negato: abilitalo in Impostazioni → Privacy → Microfono.");
        } else if (e.error === "no-speech") {
          setVoiceNote("Nessun parlato rilevato. Riprovo…");
        } else if (e.error === "network") {
          setVoiceNote("Riconoscimento non disponibile offline (Chrome usa un servizio remoto). Usa i comandi manuali.");
        } else {
          setVoiceNote("Voce: " + e.error);
        }
      };
      rec.onend = () => {
        listening = false;
        if (wantListen) { try { rec.start(); } catch (_) {} }
        else { $("#btn-mic").classList.remove("on"); setStatus("ONLINE", "on"); }
      };
    }
    rec.lang = $("#sel-lang").value;
    try { rec.start(); } catch (_) { /* già attivo */ }
    startMeter();
  }

  function stopVoice() {
    if (S.whisper) { stopLocalVoice(); return; }
    wantListen = false;
    if (rec) { try { rec.stop(); } catch (_) {} }
    $("#btn-mic").classList.remove("on");
    setStatus("ONLINE", "on");
    stopMeter();
    setVoiceNote("Mic off. I comandi manuali restano attivi.");
  }

  async function startMeter() {
    try {
      if (!navigator.mediaDevices) return;
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = audioCtx || new AC();
      const src = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (const v of buf) sum += v;
        const level = clamp((sum / buf.length) * 1.8, 0, 100);
        $("#voice-level").style.width = level + "%";
        levelRAF = requestAnimationFrame(loop);
      };
      loop();
    } catch (_) {
      setVoiceNote("Microfono non accessibile per il meter, ma il riconoscimento può funzionare comunque.");
    }
  }

  function stopMeter() {
    if (levelRAF) cancelAnimationFrame(levelRAF);
    levelRAF = 0;
    $("#voice-level").style.width = "0%";
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    analyser = null;
  }

  /* ── caricamento foto ──────────────────────────────────────────────── */
  /* ── eject: espelle la lastra e libera il banco ────────────────────────
     Non è un "reset": il reset azzera la vista, l'eject toglie la fotografia
     e riporta la macchina allo stato di inserimento, pronta per la prossima. */
  function ejectFrame() {
    if (!S.photo) {
      playSfx("fault", { vol: 0.45 });
      setVoiceNote("Nessuna lastra nel letto — il banco è già vuoto.");
      log("EJECT", "NO FRAME");
      return false;
    }
    stopMotion();
    S.tiles.forEach((t) => t.el.remove());
    S.tiles = [];
    $("#sig-tiles").textContent = "0";
    hist.length = 0;
    S.photo = null;
    S.busy = false;
    base.removeAttribute("src");
    base.style.width = "1px";
    base.style.height = "1px";
    $("#tiles").innerHTML = "";
    $("#ro-file").textContent = "—";
    $("#ro-src").textContent = "—";
    $("#in-ns").value = "";
    $("#in-ew").value = "";
    $("#in-zm").value = "1000";
    renderMeta({});
    $("#insert").classList.remove("gone");
    $("#insert-title").textContent = "INSERT A FRAME";
    $("#insert-sub").textContent = "EJECT COMPLETE — FEED A NEW NEGATIVE, OR CASE FILE 01";
    $("#hud-op").textContent = "NO FRAME";
    $("#hud-sub").textContent = "AWAITING INSERT";
    setStatus("ONLINE", "on");
    playSfx("paper", { vol: 0.5, rate: 0.92 });          // la lastra che scivola fuori
    setTimeout(() => playSfx("select", { vol: 0.55, rate: 0.95 }), 190);
    log("EJECT", "FRAME REMOVED — READY FOR A NEW ONE");
    return true;
  }

  async function loadPhoto(blobOrFile, name) {
    const fd = new FormData();
    fd.append("file", blobOrFile, name || "photo.jpg");
    setStatus("LOADING", "busy");
    $("#busy").classList.add("on");
    $("#busy-title").textContent = "INSERTING PHOTO";
    $("#busy-sub").textContent = "READING EMULSION";
    try {
      const res = await fetch("/api/photo", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const info = await res.json();
      await mountPhoto(info);
      log("PHOTO", `${info.w}×${info.h} · ${(info.bytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      setStatus("ERROR", "");
      $("#insert-title").textContent = "UNREADABLE";
      $("#insert-sub").textContent = String(err.message || err);
      $("#busy").classList.remove("on");
      playSfx("fault");
    }
  }

  async function loadDemo() {
    setStatus("LOADING", "busy");
    try {
      const res = await fetch("/api/demo", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const info = await res.json();
      await mountPhoto(info);
      log("PHOTO", "CASE FILE 01 — ZHORA");
    } catch (err) {
      $("#insert-sub").textContent = "Demo non disponibile: " + (err.message || err);
    }
  }

  async function mountPhoto(info) {
    S.photo = info;
    renderMeta(info);
    S.tiles.forEach((t) => t.el.remove());
    S.tiles = [];
    $("#sig-tiles").textContent = "0";

    await new Promise((resolve, reject) => {
      base.onload = resolve;
      base.onerror = reject;
      base.src = `/api/photo/${info.id}/preview.jpg?w=2400`;
    });
    base.style.width = info.w + "px";
    base.style.height = info.h + "px";

    $("#ro-file").textContent = (info.name || "UNTITLED").slice(0, 26).toUpperCase();
    $("#ro-src").textContent = `${info.w} × ${info.h}`;
    $("#insert").classList.add("gone");
    $("#hud-op").textContent = "PHOTO LOADED";
    $("#hud-sub").textContent = "AWAITING COMMAND";
    fitView();
    paintYScale();
    $("#in-ns").value = fmtCoord(info.h / 2);
    $("#in-ew").value = fmtCoord(info.w / 2);
    $("#in-zm").value = "1000";
    $("#in-a").value = "224";
    $("#in-b").value = "176";
    setStatus("ONLINE", "on");
    $("#busy").classList.remove("on");
    $("#scanline").classList.remove("run");
    void $("#scanline").offsetWidth;
    $("#scanline").classList.add("run");
    playSfx("zoom", { rate: 1.1, vol: 0.9 });
    // eco del fruscio: la foto si è posata sul vetro, non "entra" più
    setTimeout(() => playSfx("paper", { vol: 0.32, rate: 1.06 }), 150);
    // l'immagine è ferma: la griglia di coordinate si accende per qualche secondo
    paintGridLabels();
    setTimeout(() => pulseCoordGrid(7600), 420);   // 4.6s + 3s
  }

  function resetView() {
    if (!S.photo) return;
    S.tiles.forEach((t) => t.el.remove());
    S.tiles = [];
    $("#sig-tiles").textContent = "0";
    $("#plus").classList.remove("on");
    S.lastMeta = null;
    fitView();
    pulseCoordGrid(6800);   // +3s
    log("RESET", "TILES CLEARED");
    $("#hud-op").textContent = "IDLE";
    $("#hud-sub").textContent = "AWAITING COMMAND";
    $("#sig-last").textContent = "—";
    $("#sig-out").textContent = "—";
    $("#sig-passes").textContent = "0";
    playSfx("select", { vol: 0.6, rate: 0.85 });
  }

  /* ── interazione: drag / wheel / dblclick ──────────────────────────── */
  let drag = null;

  viewport.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#insert") || e.target.closest("#busy")) return;
    if (!S.photo) return;
    // in full screen il capture è nel top layer: se un pointer anomalo lo rifiuta,
    // il drag deve comunque partire invece di lasciare la vista bloccata
    try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
    drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty, moved: 0 };
    viewport.classList.add("dragging");
  });

  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    S.tx = drag.tx + dx;
    S.ty = drag.ty + dy;
    clampPan();
    applyView();
  });

  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    viewport.classList.remove("dragging");
    if (moved < 4 && S.autoEnhance) { /* click secco */ }
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  let lastWheelTick = 0;
  viewport.addEventListener("wheel", (e) => {
    if (!S.photo) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * 0.0016);
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, f, false);
    // tic meccanico dello zoom, non a ogni pixel di rotella
    const nowMs = performance.now();
    if (nowMs - lastWheelTick > 180) {
      lastWheelTick = nowMs;
      playSfx("select", { vol: 0.22, rate: 1.28 });
    }
  }, { passive: false });

  viewport.addEventListener("dblclick", (e) => {
    if (!S.photo) return;
    const rect = viewport.getBoundingClientRect();
    const p = screenToNative(e.clientX - rect.left, e.clientY - rect.top);
    const w = clamp(S.photo.w / 8, 24, 600);
    enhance({ x: clamp(p.x - w / 2, 0, S.photo.w - w), y: clamp(p.y - w / 3, 0, S.photo.h - w), w, h: w },
      { label: "ENHANCE POINT", factor: 6 });
  });

  /* ── trackball ─────────────────────────────────────────────────────── */
  (() => {
    const tb = $("#trackball");
    const ball = $("#trackball-ball");
    let td = null;
    tb.addEventListener("pointerdown", (e) => {
      if (!S.photo) return;
      tb.setPointerCapture(e.pointerId);
      td = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty };
    });
    tb.addEventListener("pointermove", (e) => {
      if (!td) return;
      const dx = e.clientX - td.x;
      const dy = e.clientY - td.y;
      const k = 2.4;
      ball.style.transform = `translate(${clamp(dx * 0.5, -26, 26)}px, ${clamp(dy * 0.5, -26, 26)}px)`;
      S.tx = td.tx + dx * k;
      S.ty = td.ty + dy * k;
      clampPan(); applyView();
    });
    const up = () => {
      if (!td) return;
      td = null;
      ball.style.transform = "translate(0px, 0px)";
      playSfx("select", { vol: 0.35, rate: 1.15 });
    };
    tb.addEventListener("pointerup", up);
    tb.addEventListener("pointercancel", up);
  })();

  /* ── bottoni / input ───────────────────────────────────────────────── */
  const CMD = {
    enhance: () => enhance(null, { label: "ENHANCE" }),
    movein: () => moveIn(),
    pullout: () => pullOut(),
    hold: () => toggleHold(),
    center: () => centerView(),
    trackleft: () => track("left"),
    trackright: () => track("right"),
    trackup: () => track("up"),
    trackdown: () => track("down"),
    print: () => hardCopy(),
    reset: () => resetView(),
  };

  document.querySelectorAll("[data-cmd]").forEach((b) => {
    b.addEventListener("click", () => {
      const fn = CMD[b.dataset.cmd];
      if (fn) { fn(); b.blur(); }
    });
  });

  $("#btn-goto").addEventListener("click", goToCoords);
  $("#btn-range").addEventListener("click", () => {
    const a = parseInt($("#in-a").value || "0", 10);
    const b = parseInt($("#in-b").value || String(S.photo ? S.photo.w : 999), 10);
    enhanceRange(a, b);
  });

  ["in-zm", "in-ns", "in-ew"].forEach((id) => {
    $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter") goToCoords(); });
  });
  ["in-a", "in-b"].forEach((id) => {
    $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-range").click(); });
  });

  $("#btn-mic").addEventListener("click", () => (wantListen || listening ? stopVoice() : startVoice()));

  /* ── rail a schede: coordinate ↔ metadati ──────────────────────────── */
  function setRail(tab) {
    document.querySelectorAll(".rail-tab").forEach((b) => {
      b.classList.toggle("on", b.dataset.rail === tab);
    });
    $("#rail-coords").classList.toggle("hidden", tab !== "coords");
    $("#rail-meta").classList.toggle("hidden", tab !== "meta");
  }
  document.querySelectorAll(".rail-tab").forEach((b) => {
    b.addEventListener("click", () => { setRail(b.dataset.rail); b.blur(); });
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function renderMeta(info) {
    const list = $("#meta-list");
    if (!list || !info) return;
    const rows = [];
    const add = (k, v) => { if (v !== undefined && v !== null && v !== "") rows.push([k, v]); };
    add("FILE", info.name);
    add("FORMAT", info.format);
    add("SIZE", info.bytes ? Math.round(info.bytes / 1024) + " KB" : "");
    add("PIXELS", info.w && info.h ? `${info.w} × ${info.h}` : "");
    add("MEGAPIXEL", info.w && info.h ? ((info.w * info.h) / 1e6).toFixed(1) + " MP" : "");
    add("RESAMPLED", info.downscaled ? "yes (max side)" : "");
    const e = info.exif || {};
    add("MAKE", e.make);
    add("MODEL", e.model);
    add("LENS", e.lens);
    add("DATE", e.date);
    add("ISO", e.iso);
    add("APERTURE", e.aperture);
    add("SHUTTER", e.shutter);
    add("FOCAL", e.focal);
    add("SOFTWARE", e.software);
    add("GPS", e.gps);
    if (!Object.keys(e).length && rows.length) {
      rows.push(["EXIF", "none — synthetic or stripped frame"]);
    }
    list.innerHTML = rows.length
      ? rows.map(([k, v]) => `<div class="mrow"><span class="mk">${esc(k)}</span><span class="mv">${esc(v)}</span></div>`).join("")
      : `<div class="mrow"><span class="mv dim">no frame loaded</span></div>`;
  }

  /* ── full screen del monitor ───────────────────────────────────────── */
  async function toggleFullScreen() {
    try {
      if (!document.fullscreenElement) {
        await $("#viewport").requestFullscreen();
        log("SCREEN", "FULL SCREEN · viewport only");
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      log("SCREEN", "full screen refused");
      playSfx("fault", { vol: 0.5 });
    }
  }
  $("#btn-full").addEventListener("click", toggleFullScreen);
  document.addEventListener("fullscreenchange", () => {
    $("#btn-full").classList.toggle("on", !!document.fullscreenElement);
    // il layout cambia dimensione: aspetta un frame prima di rifare il clamp
    requestAnimationFrame(() => { if (S.photo) { clampPan(); applyView(); } });
  });

  /* ── operator card ─────────────────────────────────────────────────── */
  const tut = $("#tutorial");
  function toggleTutorial(force) {
    if (!tut) return;
    const on = force === undefined ? !tut.classList.contains("on") : !!force;
    tut.classList.toggle("on", on);
    playSfx("select", on ? { vol: 0.6 } : { vol: 0.4, rate: 0.86 });
  }
  $("#btn-tutorial").addEventListener("click", () => toggleTutorial());
  $("#tut-close").addEventListener("click", () => toggleTutorial(false));
  tut.addEventListener("click", (e) => { if (e.target === tut) toggleTutorial(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tut.classList.contains("on")) toggleTutorial(false);
  });

  $("#btn-sfx").addEventListener("click", async () => {
    if (!SFX.ctx) await initSfx();
    if (SFX.ctx && SFX.ctx.state === "suspended") await SFX.ctx.resume();
    S.audio = true;
    $("#chk-audio").checked = true;
    ["paper", "select", "zoom", "enhance", "shutter", "fault"].forEach((n, i) =>
      setTimeout(() => playSfx(n), i * 480));
  });
  $("#sel-lang").addEventListener("change", () => {
    if (rec) { wantListen = false; try { rec.stop(); } catch (_) {} }
    setTimeout(() => { if (rec) startVoice(); }, 250);
  });

  function setRender(mode) {
    S.render = mode;
    viewport.classList.toggle("pixel", mode === "pixel");
    document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === mode);
    });
    const badge = $("#mode-badge");
    if (badge) { badge.textContent = mode.toUpperCase(); badge.dataset.mode = mode; }
    log("RENDER", mode === "pixel" ? "PIXEL · MODEL OFF" : mode === "text" ? "TEXT · TTA ×2" : "AI · SUPER-RESOLUTION");
    updateFidelity(S.fitScale ? S.scale / S.fitScale : 1);
    playSfx("select", { vol: 0.6 });
  }

  document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => {
    b.addEventListener("click", () => { setRender(b.dataset.mode); b.blur(); });
  });

  /* ── filtri immagine ───────────────────────────────────────────────── */
  const FILTER_LABEL = {
    chromo: "CHROMO · FOSFORO CIANO",
    natural: "NATURAL · COLORI VERI",
    ir: "INFRARED · FALSO COLORE",
    thermal: "THERMAL · MAPPA DI CALORE",
  };
  const FILTER_ORDER = ["chromo", "natural", "ir", "thermal"];
  S.filter = "chromo";

  function setFilter(name, opts = {}) {
    if (!FILTER_LABEL[name]) name = "chromo";
    S.filter = name;
    screenEl.dataset.filter = name;
    document.querySelectorAll(".mode-btn[data-filter]").forEach((b) => {
      b.classList.toggle("on", b.dataset.filter === name);
    });
    // la lastra non si ricorda: riparte sempre dal ciano (nessun innesco "spontaneo")
    if (!opts.quiet) {
      // la fonte è parte del dato: senza, un cambio "spontaneo" resta un mistero
      const src = opts.source || "UI";
      const heard = opts.text ? ` · ${src} «${String(opts.text).toUpperCase()}»` : ` · ${src}`;
      log("FILTER", FILTER_LABEL[name] + heard);
      playSfx("select", { vol: 0.55 });
    }
  }

  function cycleFilter(source) {
    const i = FILTER_ORDER.indexOf(S.filter || "chromo");
    setFilter(FILTER_ORDER[(i + 1) % FILTER_ORDER.length], { source: source || "KEY" });
  }

  document.querySelectorAll(".mode-btn[data-filter]").forEach((b) => {
    b.addEventListener("click", () => { setFilter(b.dataset.filter, { source: "CLICK" }); b.blur(); });
  });

  try {
    try { localStorage.removeItem("esper.filter"); } catch (_) {}   // pulizia dei residui
    setFilter("chromo", { quiet: true });
  } catch (_) {}

  $("#chk-auto").addEventListener("change", (e) => { S.autoEnhance = e.target.checked; });
  $("#chk-audio").addEventListener("change", (e) => {
    S.audio = e.target.checked;
    if (S.audio) { playSfx("select"); startHum(); } else { stopHum(); }
  });
  $("#chk-grid").addEventListener("change", (e) => {
    $("#grid-lines").classList.toggle("off", !e.target.checked);
  });

  $("#in-gain").addEventListener("input", (e) => {
    const v = +e.target.value;
    // 100 = gain nominale 1.12; la scala va da 0.56 a 2.46
    document.documentElement.style.setProperty("--gain", (v / 100 * 1.12).toFixed(3));
    $("#gain-val").textContent = v;
  });

  /* ── file input / drag&drop ────────────────────────────────────────── */
  $("#btn-open").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadPhoto(f, f.name);
  });
  $("#btn-demo").addEventListener("click", loadDemo);
  $("#btn-eject").addEventListener("click", ejectFrame);
  (() => {
    const sel = $("#sel-lang");
    if (!sel) return;
    try {
      const saved = localStorage.getItem("esper.lang");
      if (saved) sel.value = saved;      // la lingua è una preferenza: si ricorda
    } catch (_) {}
    sel.addEventListener("change", () => {
      try { localStorage.setItem("esper.lang", sel.value); } catch (_) {}
      log("VOICE", "LINGUA " + (sel.value.startsWith("it") ? "IT" : "EN"));
    });
  })();
  document.querySelectorAll(".tdot").forEach((b) =>
    b.addEventListener("click", () => { setTheme(b.dataset.theme); playSfx("select", { vol: 0.7 }); })
  );

  let dragDepth = 0;
  ["dragenter", "dragover"].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragenter") dragDepth++;
      viewport.classList.add("dropping");
    })
  );
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; viewport.classList.remove("dropping"); }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    viewport.classList.remove("dropping");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadPhoto(f, f.name);
  });

  /* ── tastiera ──────────────────────────────────────────────────────── */
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    // ⌘I / ⌃I / ⌥I sono scorciatoie del sistema: non devono cambiare lastra
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "e") { enhance(null, { label: "ENHANCE" }); e.preventDefault(); }
    else if (k === "+" || k === "=") { moveIn(1.3); e.preventDefault(); }
    else if (k === "-" || k === "_") { pullOut(1.3); e.preventDefault(); }
    else if (k === "arrowleft") { track("left", 8); e.preventDefault(); }
    else if (k === "arrowright") { track("right", 8); e.preventDefault(); }
    else if (k === "arrowup") { track("up", 8); e.preventDefault(); }
    else if (k === "arrowdown") { track("down", 8); e.preventDefault(); }
    else if (k === "c") { centerView(); e.preventDefault(); }
    else if (k === "p") { hardCopy(); e.preventDefault(); }
    else if (k === "h") { if (e.shiftKey) startZoomHold(-(S.lastZoomDir || 1)); else toggleHold(); e.preventDefault(); }
    else if (k === "s") { stopMotion(); e.preventDefault(); }
    else if (k === "f") { fitView(); e.preventDefault(); }
    else if (k === "i") { cycleFilter(); e.preventDefault(); }
    else if (k === "x") { ejectFrame(); e.preventDefault(); }
    else if (k === "t") { cycleTheme(); e.preventDefault(); }
  });

  /* ── tick / clock ──────────────────────────────────────────────────── */
  setInterval(() => {
    const t = now();
    $("#clock").textContent = t;
    $("#hud-clock").textContent = t;
  }, 1000);

  window.addEventListener("resize", () => {
    if (S.photo) { clampPan(); applyView(); }
  });

  /* ── boot sequence ─────────────────────────────────────────────────── */
  (function boot() {
    const el = document.createElement("div");
    el.id = "boot";
    el.textContent = "";
    $("#screen").appendChild(el);
    const lines = [
      "ESPER PHOTO ANALYSIS UNIT — TYRELL CORP. MODEL 5",
      "BIOS 2.41 (c) TYRELL CORPORATION 2016",
      "",
      "MEMORY ............ 64K OK",
      "OPTICAL DRIVE ..... READY",
      "RASTER SCANNER .... CALIBRATING",
      "VOICE CODEC ....... ENABLED",
      "",
      "> SYSTEM READY",
    ];
    let i = 0;
    const out = [];
    const tick = setInterval(() => {
      out.push(lines[i]);
      el.textContent = out.join("\n") + (i < lines.length - 1 ? "\n_" : "");
      i++;
      if (i >= lines.length) clearInterval(tick);
    }, 70);

    const dismiss = () => {
      clearInterval(tick);
      el.classList.add("gone");
      setTimeout(() => el.remove(), 400);
    };
    // chiusura garantita, indipendente dal throttling dei timer
    const t = setTimeout(dismiss, 1100);
    const skip = () => { clearTimeout(t); dismiss(); };
    window.addEventListener("keydown", skip, { once: true });
    window.addEventListener("pointerdown", skip, { once: true });
  })();

  /* ── scala verticale: tacche in pixel reali ────────────────────────── */
  function paintYScale() {
    const box = $("#scale-y-ticks");
    box.innerHTML = "";
    const H = S.photo ? S.photo.h : 9999;
    for (let i = 0; i <= 20; i++) {
      const pct = i * 5;
      const t = document.createElement("i");
      t.style.top = pct + "%";
      if (i % 2 === 0) t.classList.add("major");
      box.appendChild(t);
      if (i % 4 === 0) {
        const s = document.createElement("span");
        s.style.top = pct + "%";
        s.textContent = fmtCoord((pct / 100) * H);
        box.appendChild(s);
      }
    }
  }
  paintYScale();

  /* ── tema salvato ──────────────────────────────────────────────────── */
  try { setTheme(localStorage.getItem("esper.theme") || "chromo", true); }
  catch (_) { setTheme("chromo", true); }

  /* ── health check iniziale ─────────────────────────────────────────── */
  (async () => {
    try {
      const r = await fetch("/api/status");
      const st = await r.json();
      S.whisper = !!st.whisper;
      if (S.whisper) {
        log("VOICE", "WHISPER LOCALE · " + (st.whisper_model || ""));
        const mb = $("#btn-mic");
        if (mb) mb.title = "whisper.cpp locale (" + (st.whisper_model || "") + ") — nessun audio esce dal Mac";
      }
      $("#sig-mode").textContent = st.mode.toUpperCase();
      $("#sig-device").textContent = st.device.toUpperCase();
      if (!st.ok) {
        $("#hud-op").textContent = "CLASSIC MODE";
        $("#hud-sub").textContent = "SR MODEL NOT LOADED — UPSCALER FALLBACK";
        log("WARN", st.error || "model not loaded");
      } else {
        log("MODEL", `${st.mode} · ${st.device}`);
      }
    } catch (_) {
      $("#hud-op").textContent = "OFFLINE";
    }
    updateHud();
  })();

  // campioni audio in background
  initSfx();

  // primo disegno
  updateHud();

  // hook di servizio: utile per test automatici e per script esterni
  window.ESPER = {
    state: S, sfx: SFX,
    enhance, handleCommand, hardCopy, fitView, track, moveIn, pullOut,
    goToCoords, enhanceRange, resetView, centerView, stopMotion,
    loadPhoto, loadDemo, playSfx, initSfx, startHum, stopHum, toggleTutorial,
    setRail, toggleFullScreen, renderMeta, fuzzyCommand, ejectFrame, setTheme, cycleTheme, cycleFilter,
    runTunnel, pulseCoordGrid, maybePrefetch, startZoomHold, toggleHold, setRender,
    humActive: () => !!humSrc,
  };
})();

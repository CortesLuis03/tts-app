"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"), counter: $("counter"), limit: $("limit"), chunkHint: $("chunk-hint"),
  model: $("model"), voice: $("voice"), voiceList: $("voice-list"), voiceText: $("voice-text"),
  speed: $("speed"), speedOut: $("speed-out"), instructions: $("instructions"),
  generate: $("generate"), error: $("error"), banner: $("banner"),
  result: $("result"), player: $("player"), downloadLast: $("download-last"),
  list: $("history-list"), empty: $("history-empty"), count: $("history-count"), badge: $("history-badge"),
  theme: $("theme-toggle"),
};
const isEleven = () => els.model.value.startsWith("elevenlabs/");
const syncEleven = () => { $("eleven-opts").hidden = !isEleven(); };
const state = { models: [], serverMax: 20000, chunk: 3000, lastItem: null, mainPlayer: null, histPlayers: [] };

/* ---------- IndexedDB ---------- */
const store = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("tts-history", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("audios", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(new Error("No se pudo abrir el almacenamiento del navegador (IndexedDB)."));
    });
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("audios", mode);
      const req = fn(tx.objectStore("audios"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(new Error("Error al acceder al historial del navegador."));
    });
  },
  add(item) { return this._tx("readwrite", (s) => s.add(item)); },
  all() { return this._tx("readonly", (s) => s.getAll()); },
  remove(id) { return this._tx("readwrite", (s) => s.delete(id)); },
};

/* ---------- utilidades ---------- */
async function api(path, options) {
  let res;
  try { res = await fetch(path, options); }
  catch { throw new Error("No se pudo contactar con el servidor. ¿Sigue corriendo uvicorn?"); }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error || body.detail || msg;
      if (typeof msg !== "string") msg = JSON.stringify(msg);
    } catch { /* no JSON */ }
    throw new Error(msg);
  }
  return res;
}
function showError(msg) { els.error.textContent = msg; els.error.hidden = !msg; }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function fileName(item) {
  const stamp = new Date(item.created_at).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `tts-${stamp}.mp3`;
}

/* ---------- reproductor con ondas ---------- */
let currentWave = null; // solo suena uno a la vez
const fmtTime = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

function wavePlayer(blob) {
  const el = document.createElement("div");
  el.className = "wave";
  el.innerHTML = `<button class="wave-btn" type="button" aria-label="Reproducir">▶</button>
    <canvas class="wave-canvas" aria-label="Forma de onda; haz clic para saltar"></canvas>
    <span class="wave-time">0:00</span>`;
  const btn = el.querySelector(".wave-btn"), canvas = el.querySelector("canvas"), time = el.querySelector(".wave-time");
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  let peaks = null;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const base = css.getPropertyValue("--border").trim() || "#ccc";
    const played = css.getPropertyValue("--accent").trim() || "#000";
    const barW = 3, gap = 2, n = Math.max(1, Math.floor(w / (barW + gap)));
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    for (let i = 0; i < n; i++) {
      const v = peaks ? peaks[Math.floor((i / n) * peaks.length)] : 0.08;
      const bh = Math.max(3, v * h);
      ctx.fillStyle = i / n < progress ? played : base;
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), (h - bh) / 2, barW, bh, 1.5);
      ctx.fill();
    }
  }

  async function computePeaks() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const buf = await ac.decodeAudioData(await blob.arrayBuffer());
      ac.close();
      const data = buf.getChannelData(0), N = 160, step = Math.floor(data.length / N) || 1;
      const raw = [];
      for (let i = 0; i < N; i++) {
        let max = 0;
        for (let j = i * step; j < Math.min((i + 1) * step, data.length); j += 8) max = Math.max(max, Math.abs(data[j]));
        raw.push(max);
      }
      const top = Math.max(...raw) || 1;
      peaks = raw.map((v) => Math.max(0.08, v / top));
      draw();
    } catch { /* sin ondas: se queda la barra plana */ }
  }

  const refresh = () => { time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`; draw(); };
  audio.addEventListener("loadedmetadata", refresh);
  audio.addEventListener("timeupdate", refresh);
  audio.addEventListener("play", () => {
    if (currentWave && currentWave !== audio) currentWave.pause();
    currentWave = audio; btn.textContent = "❚❚"; btn.setAttribute("aria-label", "Pausar");
  });
  const stopped = () => { btn.textContent = "▶"; btn.setAttribute("aria-label", "Reproducir"); };
  audio.addEventListener("pause", stopped);
  audio.addEventListener("ended", () => { stopped(); audio.currentTime = 0; refresh(); });
  btn.addEventListener("click", () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
  canvas.addEventListener("click", (ev) => {
    if (!audio.duration) return;
    const r = canvas.getBoundingClientRect();
    audio.currentTime = ((ev.clientX - r.left) / r.width) * audio.duration;
    refresh();
  });
  const ro = new ResizeObserver(draw);
  ro.observe(canvas);
  const onTheme = () => draw();
  window.addEventListener("themechange", onTheme);
  computePeaks();
  time.textContent = "0:00";

  return {
    el,
    play: () => audio.play().catch(() => { /* autoplay bloqueado */ }),
    destroy() {
      audio.pause(); ro.disconnect();
      window.removeEventListener("themechange", onTheme);
      URL.revokeObjectURL(url);
    },
  };
}

/* ---------- tema y vistas ---------- */
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch { /* sin storage */ }
  document.documentElement.dataset.theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  els.theme.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    window.dispatchEvent(new Event("themechange"));
    try { localStorage.setItem("theme", next); } catch { /* ignorar */ }
  });
}
function showView(name) {
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("view-tts").hidden = name !== "tts";
  $("view-history").hidden = name !== "history";
  if (name === "history") renderHistory();
}

/* ---------- contador y límite ---------- */
function currentLimit() {
  const v = parseInt(els.limit.value, 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, state.serverMax) : state.serverMax;
}
function updateCounter() {
  const n = els.text.value.length, lim = currentLimit();
  els.counter.textContent = `${n.toLocaleString("es")} / ${lim.toLocaleString("es")} caracteres`;
  els.counter.classList.toggle("over", n > lim);
  const parts = Math.ceil(n / state.chunk);
  els.chunkHint.textContent = parts > 1 ? `Se generará en ~${parts} fragmentos` : "";
}

/* ---------- modelos y voces ---------- */
function fillVoices() {
  const model = state.models.find((m) => m.id === els.model.value);
  const voices = model ? model.voices : [];
  els.voiceText.hidden = voices.length !== 0;
  els.voiceList.hidden = voices.length === 0;
  els.voice.innerHTML = voices.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  els.voiceList.innerHTML = voices.map((v) => `<li class="voice-item" data-voice="${esc(v)}">
      <button class="voice-pick" type="button" role="radio">${esc(v)}</button>
      <button class="play-btn" type="button" title="Escuchar muestra de ${esc(v)}" aria-label="Escuchar muestra de ${esc(v)}">▶</button>
    </li>`).join("");
  selectVoice(voices[0]);
}
function selectVoice(v) {
  if (v === undefined) return;
  els.voice.value = v;
  els.voiceList.querySelectorAll(".voice-item").forEach((li) => {
    const on = li.dataset.voice === v;
    li.classList.toggle("selected", on);
    li.querySelector(".voice-pick").setAttribute("aria-checked", on);
  });
}
const sample = new Audio();
async function playSample(btn, voice) {
  showError("");
  sample.pause();
  els.voiceList.querySelectorAll(".play-btn").forEach((b) => { b.textContent = "▶"; });
  btn.disabled = true; btn.textContent = "…";
  try {
    const res = await api(`/api/preview?model=${encodeURIComponent(els.model.value)}&voice=${encodeURIComponent(voice)}`);
    const url = URL.createObjectURL(await res.blob());
    sample.src = url;
    sample.onended = () => { btn.textContent = "▶"; URL.revokeObjectURL(url); };
    await sample.play();
    btn.textContent = "■";
  } catch (e) { btn.textContent = "▶"; showError(e.message); }
  finally { btn.disabled = false; }
}
els.voiceList.addEventListener("click", (ev) => {
  const li = ev.target.closest(".voice-item");
  if (!li) return;
  const voice = li.dataset.voice;
  if (ev.target.closest(".play-btn")) {
    const btn = li.querySelector(".play-btn");
    if (btn.textContent === "■") { sample.pause(); btn.textContent = "▶"; return; }
    selectVoice(voice); playSample(btn, voice);
  } else selectVoice(voice);
});
function currentVoice() {
  if (els.voiceList.hidden) return els.voiceText.value.trim();
  const sel = els.voiceList.querySelector(".voice-item.selected");
  return sel ? sel.dataset.voice : els.voice.value;
}
async function loadModels() {
  const data = await (await api("/api/models")).json();
  state.models = data.models;
  els.model.innerHTML = data.models
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.free ? " (gratis)" : ""}</option>`).join("");
  if (data.default) els.model.value = data.default;
  fillVoices();
}

/* ---------- generar ---------- */
async function generate() {
  showError("");
  const text = els.text.value.trim();
  if (!text) return showError("Escribe algún texto antes de generar.");
  if (text.length > currentLimit()) return showError(`El texto supera el límite de ${currentLimit()} caracteres.`);
  const voice = currentVoice();
  if (!voice) return showError("Selecciona o escribe una voz.");

  els.generate.disabled = true;
  els.generate.textContent = "Generando…";
  try {
    const res = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text, model: els.model.value, voice,
        speed: parseFloat(els.speed.value),
        instructions: els.instructions.value.trim(),
        ...(isEleven() ? {
          stability: parseFloat($("stability").value),
          similarity: parseFloat($("similarity").value),
          style: parseFloat($("style").value),
          speaker_boost: $("boost").checked,
          language: $("language").value || null,
        } : {}),
      }),
    });
    const blob = await res.blob();
    const item = {
      text, model: els.model.value, voice, speed: parseFloat(els.speed.value),
      instructions: els.instructions.value.trim(), chars: text.length,
      created_at: new Date().toISOString(), blob,
    };
    try { item.id = await store.add(item); }
    catch (e) { showError(`Audio generado, pero no se pudo guardar en el historial: ${e.message}`); }

    state.lastItem = item;
    if (state.mainPlayer) state.mainPlayer.destroy();
    state.mainPlayer = wavePlayer(blob);
    els.player.replaceChildren(state.mainPlayer.el);
    els.result.hidden = false;
    els.downloadLast.disabled = false;
    state.mainPlayer.play();
    refreshBadge();
  } catch (e) {
    showError(e.message);
  } finally {
    els.generate.disabled = false;
    els.generate.textContent = "Generar audio";
  }
}

/* ---------- historial ---------- */
async function refreshBadge() {
  try {
    const n = (await store.all()).length;
    els.badge.textContent = n; els.badge.hidden = n === 0;
  } catch { /* ignorar */ }
}

async function renderHistory() {
  state.histPlayers.forEach((p) => p.destroy());
  state.histPlayers = [];
  let items = [];
  try { items = (await store.all()).reverse(); } catch (e) { showError(e.message); }
  els.empty.hidden = items.length > 0;
  els.count.textContent = items.length ? `${items.length} audio${items.length > 1 ? "s" : ""}` : "";
  els.list.innerHTML = items.map((it) => {
    const date = new Date(it.created_at).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
    return `<li class="history-item" data-id="${it.id}">
      <p class="snippet">${esc(it.text)}</p>
      <div class="meta">${esc(it.model)} · ${esc(it.voice)} · ${date}</div>
      <div class="wave-slot"></div>
      <div class="actions">
        <button class="btn" data-act="download" type="button">Descargar MP3</button>
        <button class="btn" data-act="reuse" type="button">Reusar texto</button>
        <button class="btn danger" data-act="delete" type="button">Eliminar</button>
      </div>
    </li>`;
  }).join("");
  els.list.querySelectorAll(".history-item").forEach((li, i) => {
    const p = wavePlayer(items[i].blob);
    state.histPlayers.push(p);
    li.querySelector(".wave-slot").replaceChildren(p.el);
  });
  refreshBadge();
}

els.list.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.closest("li").dataset.id);
  try {
    const it = (await store.all()).find((x) => x.id === id);
    if (btn.dataset.act === "delete") {
      // Confirmación en la página (los diálogos confirm() pueden estar bloqueados en el navegador)
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        btn.textContent = "¿Seguro? Clic para confirmar";
        setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Eliminar"; }, 4000);
        return;
      }
      await store.remove(id);
      renderHistory();
    } else if (it && btn.dataset.act === "download") {
      downloadBlob(it.blob, fileName(it));
    } else if (it && btn.dataset.act === "reuse") {
      els.text.value = it.text; els.instructions.value = it.instructions || "";
      updateCounter(); showView("tts");
    }
  } catch (e) { showError(e.message); }
});

/* ---------- arranque ---------- */
async function init() {
  initTheme();
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  els.speed.addEventListener("input", () => { els.speedOut.textContent = `${parseFloat(els.speed.value).toFixed(2)}×`; });
  els.text.addEventListener("input", updateCounter);
  els.limit.addEventListener("input", updateCounter);
  els.model.addEventListener("change", () => { fillVoices(); syncEleven(); });
  ["stability", "similarity", "style"].forEach((id) =>
    $(id).addEventListener("input", () => { $(id + "-out").textContent = parseFloat($(id).value).toFixed(2); }));
  els.generate.addEventListener("click", generate);
  els.downloadLast.addEventListener("click", () => state.lastItem && downloadBlob(state.lastItem.blob, fileName(state.lastItem)));

  try {
    const cfg = await (await api("/api/config")).json();
    state.serverMax = cfg.max_chars; state.chunk = cfg.chunk_chars;
    els.limit.value = cfg.max_chars; els.limit.max = cfg.max_chars;
    if (!cfg.has_api_key) {
      els.banner.textContent = "Falta la API key: define OPENROUTER_API_KEY en el archivo .env y reinicia el servidor.";
      els.banner.hidden = false;
    }
  } catch (e) { showError(e.message); }
  updateCounter();
  refreshBadge();
  try { await loadModels(); syncEleven(); } catch (e) { showError(e.message); }
}
init();

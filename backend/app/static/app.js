const $ = (id) => document.getElementById(id);

const terminal = $("terminal");
const connStatus = $("connStatus");

const tabPrint = $("tabPrint");
    startUpdateWatcher();
const tabMotion = $("tabMotion");
const tabSystem = $("tabSystem");
const panelPrint = $("panelPrint");
const panelMotion = $("panelMotion");
const panelSystem = $("panelSystem");

const portSelect = $("portSelect");
const baudInput = $("baudInput");
const refreshPortsBtn = $("refreshPortsBtn");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");

const hotendSet = $("hotendSet");
const bedSet = $("bedSet");
const setTempBtn = $("setTempBtn");
const hotendOffBtn = $("hotendOffBtn");
const bedOffBtn = $("bedOffBtn");
const allOffBtn = $("allOffBtn");

const uploadInput = $("uploadInput");
const uploadBtn = $("uploadBtn");
const refreshFilesBtn = $("refreshFilesBtn");
const deleteFileBtn = $("deleteFileBtn");
const fileList = $("fileList");
const filePreview = $("filePreview");
const selectedFile = $("selectedFile");

const startBtn = $("startBtn");
const pauseBtn = $("pauseBtn");
const resumeBtn = $("resumeBtn");
const cancelBtn = $("cancelBtn");

const jobFile = $("jobFile");
const jobState = $("jobState");
const jobProgress = $("jobProgress");
const hotend = $("hotend");
const bed = $("bed");

const cmdInput = $("cmdInput");
const sendBtn = $("sendBtn");
const pollBtn = $("pollBtn");

const tlStartBtn = $("tlStartBtn");
const tlStopBtn = $("tlStopBtn");
const tlRefreshBtn = $("tlRefreshBtn");
const tlLastLink = $("tlLastLink");
const tlMeta = $("tlMeta");
const tlList = $("tlList");
const tlLiveImg = $("tlLiveImg");
const tlLiveHint = $("tlLiveHint");

const jogStep = $("jogStep");
const jogXNeg = $("jogXNeg");
const jogXPos = $("jogXPos");
const jogYNeg = $("jogYNeg");
const jogYPos = $("jogYPos");
const jogZUp = $("jogZUp");
const jogZDown = $("jogZDown");
const homeBtn = $("homeBtn");
const g29Btn = $("g29Btn");
const pidHotendTemp = $("pidHotendTemp");
const pidHotendCycles = $("pidHotendCycles");
const pidHotendBtn = $("pidHotendBtn");
const pidBedTemp = $("pidBedTemp");
const pidBedCycles = $("pidBedCycles");
const pidBedBtn = $("pidBedBtn");

const updateBanner = $("updateBanner");
const updateBannerText = $("updateBannerText");
const updateReloadBtn = $("updateReloadBtn");

let selectedFilename = "";

let lastStatus;

let initialBuild;
let initialVersion;

let toolpathState = {
  filename: "",
  data: null,
  canvas: null,
  layerIndex: 0,
  layerPinned: false,
  jobLine: null,
  zoom: 1,
  _animRaf: null,
  _animOn: false,
};

function setToolpathAnimation(on) {
  const want = !!on;
  if (toolpathState._animOn === want) return;
  toolpathState._animOn = want;

  if (!want) {
    if (toolpathState._animRaf) {
      cancelAnimationFrame(toolpathState._animRaf);
      toolpathState._animRaf = null;
    }
    // Draw once in a stable state.
    redrawToolpath();
    return;
  }

  const tick = (t) => {
    if (!toolpathState._animOn) return;
    if (!toolpathState.data || !toolpathState.canvas) return;
    if (document.hidden) {
      toolpathState._animRaf = requestAnimationFrame(tick);
      return;
    }
    redrawToolpath(t);
    toolpathState._animRaf = requestAnimationFrame(tick);
  };
  toolpathState._animRaf = requestAnimationFrame(tick);
}

function setActiveTab(name) {
  const isPrint = name === "print";
  const isMotion = name === "motion";
  const isSystem = name === "system";

  tabPrint.classList.toggle("active", isPrint);
  tabMotion.classList.toggle("active", isMotion);
  tabSystem.classList.toggle("active", isSystem);

  panelPrint.classList.toggle("hidden", !isPrint);
  panelMotion.classList.toggle("hidden", !isMotion);
  panelSystem.classList.toggle("hidden", !isSystem);
}

tabPrint.onclick = () => setActiveTab("print");
tabMotion.onclick = () => setActiveTab("motion");
tabSystem.onclick = () => setActiveTab("system");

function wsReady() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function showUpdateBanner({ version, build } = {}) {
  if (!updateBanner) return;
  const v = version ? String(version) : "";
  const b = build ? String(build) : "";
  const suffix = v || b ? ` (${[v, b].filter(Boolean).join(" • ")})` : "";
  if (updateBannerText) updateBannerText.textContent = `Nova atualização disponível${suffix}.`;
  updateBanner.style.display = "flex";
}

async function startUpdateWatcher() {
  if (!updateBanner) return;

  if (updateReloadBtn) {
    updateReloadBtn.onclick = () => {
      // Simple reload; cache-busting is already in index.html.
      location.reload();
    };
  }

  const fetchVersion = async () => {
    try {
      const v = await api("/api/version");
      const ver = v && typeof v === "object" ? v.version : null;
      const build = v && typeof v === "object" ? v.build : null;

      if (initialBuild === undefined && initialVersion === undefined) {
        initialBuild = build;
        initialVersion = ver;
        return;
      }

      const changed =
        (build != null && initialBuild != null && String(build) !== String(initialBuild)) ||
        (ver != null && initialVersion != null && String(ver) !== String(initialVersion));

      if (changed) {
        showUpdateBanner({ version: ver, build });
      }
    } catch {
      // ignore
    }
  };

  // Initial check + polling.
  fetchVersion();
  setInterval(fetchVersion, 30_000);
}

function wsSend(command) {
  const c = String(command || "").trim();
  if (!c) return;
  if (!wsReady()) {
    log("[erro] WebSocket não conectado");
    return;
  }
  log(`> ${c}`);
  ws.send(JSON.stringify({ type: "send", command: c }));
}

// Movimento / calibração
homeBtn.onclick = () => wsSend("G28");
g29Btn.onclick = () => wsSend("G29");

jogXNeg.onclick = () => jog("X", -getJogStepMm());
jogXPos.onclick = () => jog("X", getJogStepMm());
jogYNeg.onclick = () => jog("Y", -getJogStepMm());
jogYPos.onclick = () => jog("Y", getJogStepMm());
jogZUp.onclick = () => jog("Z", getJogStepMm());
jogZDown.onclick = () => jog("Z", -getJogStepMm());

pidHotendBtn.onclick = () => {
  const t = Number(pidHotendTemp.value || 200);
  const c = Number(pidHotendCycles.value || 5);
  if (!Number.isFinite(t) || t <= 0) return log("[erro] Hotend alvo inválido");
  if (!Number.isFinite(c) || c < 1) return log("[erro] Ciclos inválidos");
  wsSend(`M303 E0 S${Math.round(t)} C${Math.round(c)}`);
};

pidBedBtn.onclick = () => {
  const t = Number(pidBedTemp.value || 60);
  const c = Number(pidBedCycles.value || 5);
  if (!Number.isFinite(t) || t <= 0) return log("[erro] Mesa alvo inválida");
  if (!Number.isFinite(c) || c < 1) return log("[erro] Ciclos inválidos");
  wsSend(`M303 E-1 S${Math.round(t)} C${Math.round(c)}`);
};

function wsSendMany(commands, spacingMs = 60) {
  if (!Array.isArray(commands) || !commands.length) return;
  // Send sequentially; avoids multi-line payloads.
  commands.forEach((c, i) => setTimeout(() => wsSend(c), i * spacingMs));
}

function getJogStepMm() {
  const v = Number(jogStep?.value || 1);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return v;
}

function jog(axis, deltaMm) {
  const dist = Number(deltaMm);
  if (!Number.isFinite(dist) || dist === 0) return;

  const abs = Math.abs(dist);
  const isZ = axis === "Z";
  const feed = isZ ? 600 : 6000;
  // G91 relative move, then restore absolute mode.
  wsSendMany(["G91", `G1 ${axis}${dist.toFixed(abs < 1 ? 3 : 2)} F${feed}`, "G90"]);
}

function log(line) {
  const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 20;
  terminal.textContent += line + "\n";
  if (atBottom) terminal.scrollTop = terminal.scrollHeight;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const data = await res.json();
      msg = data.detail || JSON.stringify(data);
    } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return await res.text();
}

async function refreshPorts() {
  const ports = await api("/api/ports");
  portSelect.innerHTML = "";
  for (const p of ports) {
    const opt = document.createElement("option");
    opt.value = p.device;
    opt.textContent = `${p.device} — ${p.description}`;
    portSelect.appendChild(opt);
  }
}

async function refreshFiles() {
  const files = await api("/api/files/list");
  fileList.innerHTML = "";

  if (!files.length) {
    fileList.innerHTML = '<div class="muted" style="padding:10px;">Nenhum .gcode enviado ainda.</div>';
    return;
  }

  const filenames = new Set(files.map((x) => x.filename));
  if (selectedFilename && !filenames.has(selectedFilename)) {
    selectedFilename = "";
    selectedFile.textContent = "—";
    filePreview.innerHTML = '<div class="muted">Selecione um arquivo para ver a prévia.</div>';
    filePreview.classList.remove("has-toolpath");
  }

  for (const f of files) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "file-item";
    item.dataset.filename = f.filename;

    const thumbUrl = `/api/files/thumbnail/${encodeURIComponent(f.filename)}`;
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "Prévia";
    img.loading = "lazy";
    img.src = thumbUrl;
    img.onerror = () => {
      img.remove();
      const ph = document.createElement("div");
      ph.className = "thumb placeholder";
      ph.textContent = "—";
      item.prepend(ph);
    };

    const meta = document.createElement("div");
    meta.className = "file-meta";
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = f.filename;
    const sub = document.createElement("div");
    sub.className = "file-sub";
    const kb = Math.max(1, Math.round((f.size_bytes || 0) / 1024));
    sub.textContent = `${kb} KB`;
    meta.appendChild(name);
    meta.appendChild(sub);

    item.appendChild(img);
    item.appendChild(meta);

    if (f.filename === selectedFilename) {
      item.classList.add("active");
    }

    item.onclick = () => {
      selectedFilename = f.filename;
      selectedFile.textContent = selectedFilename;
      for (const el of fileList.querySelectorAll(".file-item")) {
        el.classList.toggle("active", el.dataset.filename === selectedFilename);
      }

      renderGcodePreview({ filename: selectedFilename, thumbUrl });
    };

    fileList.appendChild(item);
  }
}

async function renderGcodePreview({ filename, thumbUrl }) {
  filePreview.innerHTML = "";
  filePreview.classList.add("has-toolpath");

  toolpathState = {
    filename,
    data: null,
    canvas: null,
    layerIndex: 0,
    layerPinned: false,
    jobLine: null,
    zoom: 1,
    _animRaf: null,
    _animOn: false,
  };

  const thumb = document.createElement("img");
  thumb.className = "preview-img";
  thumb.alt = "Thumbnail do G-code";
  thumb.src = thumbUrl;
  thumb.onerror = () => {
    thumb.remove();
  };

  const label = document.createElement("div");
  label.className = "muted";
  label.style.marginTop = "8px";
  label.textContent = "Visualização do caminho (toolpath)";

  const canvas = document.createElement("canvas");
  canvas.className = "toolpath-canvas";

  const hint = document.createElement("div");
  hint.className = "muted";
  hint.style.marginTop = "6px";
  hint.textContent = "Carregando visualização...";

  filePreview.appendChild(thumb);
  filePreview.appendChild(label);

  const controls = document.createElement("div");
  controls.className = "toolpath-controls";

  const layerLabel = document.createElement("div");
  layerLabel.className = "muted";
  layerLabel.id = "toolpathLayerLabel";
  controls.appendChild(layerLabel);

  const zoomLabel = document.createElement("div");
  zoomLabel.className = "muted";
  zoomLabel.id = "toolpathZoomLabel";
  controls.appendChild(zoomLabel);

  const zoomSlider = document.createElement("input");
  zoomSlider.type = "range";
  zoomSlider.min = "0.6";
  zoomSlider.max = "10";
  zoomSlider.step = "0.1";
  zoomSlider.value = String(toolpathState.zoom);
  zoomSlider.className = "toolpath-slider";
  zoomSlider.oninput = () => {
    toolpathState.zoom = Math.min(10, Math.max(0.6, Number(zoomSlider.value || 1) || 1));
    updateToolpathZoomLabel();
    redrawToolpath();
  };
  controls.appendChild(zoomSlider);

  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.className = "secondary";
  fitBtn.textContent = "Ajustar";
  fitBtn.onclick = () => {
    toolpathState.zoom = 1;
    zoomSlider.value = "1";
    updateToolpathZoomLabel();
    redrawToolpath();
  };
  controls.appendChild(fitBtn);

  filePreview.appendChild(controls);
  filePreview.appendChild(canvas);
  filePreview.appendChild(hint);

  let data;
  try {
    data = await api(`/api/files/toolpath/${encodeURIComponent(filename)}?max_segments=50000`);
  } catch (e) {
    canvas.remove();
    label.remove();
    hint.textContent = `Sem visualização do G-code: ${e.message}`;
    if (!filePreview.querySelector("img")) {
      hint.textContent = "Sem visualização (toolpath/thumbnail).";
    }
    filePreview.classList.remove("has-toolpath");
    setToolpathAnimation(false);
    return;
  }

  if (!data || !data.segments || !data.segments.length) {
    canvas.remove();
    label.remove();
    hint.textContent = "Sem movimentos XY para visualizar.";
    filePreview.classList.remove("has-toolpath");
    setToolpathAnimation(false);
    return;
  }

  hint.textContent = "";

  toolpathState.data = data;
  toolpathState.canvas = canvas;

  // If we are already printing this file, highlight progress immediately.
  try {
    if (
      lastStatus &&
      lastStatus.job_file &&
      String(lastStatus.job_file) === String(filename) &&
      lastStatus.job_state &&
      lastStatus.job_state !== "idle" &&
      lastStatus.job_line != null
    ) {
      toolpathState.jobLine = Number(lastStatus.job_line);
    }
  } catch {
    // ignore
  }

  const layers = Array.isArray(data.layers) ? data.layers : [];

  // Default to the first layer that actually has geometry (prefer extrusion).
  toolpathState.layerIndex = pickDefaultLayerIndex(data);

  if (layers.length > 1) {
    const layerSlider = document.createElement("input");
    layerSlider.type = "range";
    layerSlider.min = "0";
    layerSlider.max = String(layers.length - 1);
    layerSlider.step = "1";
    layerSlider.value = String(toolpathState.layerIndex || 0);
    layerSlider.className = "toolpath-slider";

    layerSlider.oninput = () => {
      toolpathState.layerPinned = true;
      toolpathState.layerIndex = Number(layerSlider.value || 0);
      updateToolpathLayerLabel();
      redrawToolpath();
    };

    // Put the layer slider right after the layer label.
    const controlsEl = filePreview.querySelector(".toolpath-controls");
    const layerLabelEl = document.getElementById("toolpathLayerLabel");
    if (controlsEl && layerLabelEl) {
      controlsEl.insertBefore(layerSlider, layerLabelEl.nextSibling);
    }
  }

  updateToolpathLayerLabel();
  updateToolpathZoomLabel();
  redrawToolpath();

  // Auto-animate only during an active print of this file.
  try {
    const anim =
      lastStatus &&
      lastStatus.job_file &&
      String(lastStatus.job_file) === String(filename) &&
      lastStatus.job_state === "printing" &&
      lastStatus.job_line != null;
    setToolpathAnimation(!!anim);
  } catch {
    setToolpathAnimation(false);
  }
}

function pickDefaultLayerIndex(data) {
  const segs = Array.isArray(data?.segments) ? data.segments : [];
  if (!segs.length) return 0;

  const counts = new Map();
  const extrCounts = new Map();
  for (const s of segs) {
    const li = Number(s.layer ?? 0);
    counts.set(li, (counts.get(li) || 0) + 1);
    if (s.extrude) extrCounts.set(li, (extrCounts.get(li) || 0) + 1);
  }

  const layers = Array.isArray(data?.layers) ? data.layers : [];
  const maxLayer = layers.length ? layers.length - 1 : Math.max(...counts.keys());

  for (let i = 0; i <= maxLayer; i++) {
    if ((extrCounts.get(i) || 0) > 0) return i;
  }
  for (let i = 0; i <= maxLayer; i++) {
    if ((counts.get(i) || 0) > 0) return i;
  }
  return 0;
}

function updateToolpathLayerLabel() {
  const data = toolpathState.data;
  if (!data) return;
  const layers = Array.isArray(data.layers) ? data.layers : [];
  const label = document.getElementById("toolpathLayerLabel");
  if (!label) return;
  if (!layers.length) {
    label.textContent = "";
    return;
  }

  const idx = Math.min(Math.max(0, toolpathState.layerIndex || 0), layers.length - 1);
  const z = layers[idx]?.z;
  const current = toolpathState.jobLine != null ? ` • linha atual: ${toolpathState.jobLine}` : "";
  label.textContent = `Camada: ${idx + 1}/${layers.length}${z != null ? ` (Z=${z})` : ""}${current}`;
}

function updateToolpathZoomLabel() {
  const label = document.getElementById("toolpathZoomLabel");
  if (!label) return;
  const z = Number(toolpathState.zoom || 1);
  const pct = Math.round((Number.isFinite(z) ? z : 1) * 100);
  label.textContent = `Zoom: ${pct}%`;
}

function findLayerForLine(layers, line) {
  if (!Array.isArray(layers) || layers.length === 0) return 0;
  if (line == null) return 0;
  const ln = Number(line);
  if (!Number.isFinite(ln)) return 0;
  let best = 0;
  for (let i = 0; i < layers.length; i++) {
    const start = Number(layers[i]?.start_line ?? 0);
    const end = Number(layers[i]?.end_line ?? start);
    if (ln >= start && ln <= end) return i;
    if (ln >= start) best = i;
  }
  return best;
}

function redrawToolpath(timeMs) {
  if (!toolpathState.data || !toolpathState.canvas) return;
  drawToolpath(toolpathState.canvas, toolpathState.data, {
    layer: toolpathState.layerIndex,
    uptoLine: toolpathState.jobLine,
    zoom: toolpathState.zoom,
    timeMs,
    animateHead: toolpathState._animOn,
  });
}

function drawToolpath(canvas, data, { layer, uptoLine, zoom, timeMs, animateHead } = {}) {
  const segsAll = Array.isArray(data.segments) ? data.segments : [];
  const layerIdx = layer == null ? null : Number(layer);

  const computeBounds = (onlyExtrude) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;

    for (const s of segsAll) {
      if (layerIdx != null && Number(s.layer ?? 0) !== layerIdx) continue;
      if (onlyExtrude && !s.extrude) continue;

      const x1 = Number(s.x1);
      const y1 = Number(s.y1);
      const x2 = Number(s.x2);
      const y2 = Number(s.y2);
      if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;

      minX = Math.min(minX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxX = Math.max(maxX, x1, x2);
      maxY = Math.max(maxY, y1, y2);
      count++;
    }

    return { minX, minY, maxX, maxY, count };
  };

  // Fit primarily to extrusion geometry to avoid huge travel moves making the print tiny.
  let b = computeBounds(true);
  if (!b.count || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX) || b.minX === b.maxX || b.minY === b.maxY) {
    b = computeBounds(false);
  }

  const minX = Number.isFinite(b.minX) ? b.minX : 0;
  const maxX = Number.isFinite(b.maxX) ? b.maxX : 1;
  const minY = Number.isFinite(b.minY) ? b.minY : 0;
  const maxY = Number.isFinite(b.maxY) ? b.maxY : 1;

  const rect = canvas.getBoundingClientRect();
  const cw = Math.max(1, Math.floor(rect.width || canvas.clientWidth || canvas.parentElement?.getBoundingClientRect?.().width || 520));
  const ch = 420;
  canvas.style.height = ch + "px";
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const pad = 14;
  const dx = Math.max(1e-6, maxX - minX);
  const dy = Math.max(1e-6, maxY - minY);
  const availW = Math.max(1, cw - pad * 2);
  const availH = Math.max(1, ch - pad * 2);
  const baseScale = Math.min(availW / dx, availH / dy);
  const z = Number(zoom);
  const zoomMul = Number.isFinite(z) ? Math.min(10, Math.max(0.6, z)) : 1;
  const scale = baseScale * zoomMul;

  const contentW = dx * scale;
  const contentH = dy * scale;
  const offX = pad + (availW - contentW) / 2;
  const offY = pad + (availH - contentH) / 2;

  const mapX = (x) => offX + (x - minX) * scale;
  const mapY = (y) => offY + (maxY - y) * scale;

  const segs = segsAll;
  const upto = uptoLine == null ? null : Number(uptoLine);

  const hasPath2D = typeof Path2D !== "undefined";

  // Split into printed vs remaining based on job line
  const travelPrinted = hasPath2D ? new Path2D() : [];
  const extrPrinted = hasPath2D ? new Path2D() : [];
  const travelRest = hasPath2D ? new Path2D() : [];
  const extrRest = hasPath2D ? new Path2D() : [];

  let lastPoint = null;
  let lastSeg = null;

  for (const s of segs) {
    if (layerIdx != null && Number(s.layer ?? 0) !== layerIdx) continue;

    const x1 = mapX(s.x1);
    const y1 = mapY(s.y1);
    const x2 = mapX(s.x2);
    const y2 = mapY(s.y2);

    const isPrinted = upto == null ? false : Number(s.line ?? 0) <= upto;
    const isExtr = !!s.extrude;

    const p = isPrinted
      ? (isExtr ? extrPrinted : travelPrinted)
      : (isExtr ? extrRest : travelRest);

    if (hasPath2D) {
      p.moveTo(x1, y1);
      p.lineTo(x2, y2);
    } else {
      p.push([x1, y1, x2, y2]);
    }

    if (isPrinted) {
      lastPoint = { x: x2, y: y2 };
      lastSeg = { x1, y1, x2, y2, isExtr };
    }
  }

  const strokeSegments = (segments, { width, color }) => {
    if (hasPath2D) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke(segments);
      return;
    }
    ctx.beginPath();
    for (const seg of segments) {
      ctx.moveTo(seg[0], seg[1]);
      ctx.lineTo(seg[2], seg[3]);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  };

  // Remaining (lighter)
  strokeSegments(travelRest, { width: 0.9, color: "#e5e7eb" });
  strokeSegments(extrRest, { width: 1.6, color: "#111827" });

  // Printed (darker/thicker)
  strokeSegments(travelPrinted, { width: 1.0, color: "#d1d5db" });
  strokeSegments(extrPrinted, { width: 2.2, color: "#111827" });

  const t = Number(timeMs);
  const canAnimate = !!animateHead && lastSeg && Number.isFinite(t);

  if (canAnimate) {
    // Move a toolhead marker along the last printed segment.
    const dur = 700; // ms
    const phase = ((t % dur) / dur + 1) % 1;
    const hx = lastSeg.x1 + (lastSeg.x2 - lastSeg.x1) * phase;
    const hy = lastSeg.y1 + (lastSeg.y2 - lastSeg.y1) * phase;

    ctx.fillStyle = lastSeg.isExtr ? "#991b1b" : "#6b7280";
    ctx.beginPath();
    ctx.arc(hx, hy, lastSeg.isExtr ? 4.2 : 3.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (lastPoint) {
    // Static marker when not animating.
    ctx.fillStyle = "#991b1b";
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 3.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderStatus(s) {
  lastStatus = s;
  const connMap = {
    connected: "conectado",
    connecting: "conectando",
    disconnected: "desconectado",
  };
  const jobMap = {
    idle: "idle",
    printing: "imprimindo",
    paused: "pausado",
    cancelling: "cancelando",
  };

  connStatus.textContent = connMap[s.connection] || s.connection;
  jobFile.textContent = s.job_file || "—";
  jobState.textContent = jobMap[s.job_state] || s.job_state;
  jobProgress.textContent = `${Math.round((s.progress || 0) * 100)}%`;
  hotend.textContent = s.hotend_c == null ? "—" : `${s.hotend_c.toFixed(1)}°C`;
  bed.textContent = s.bed_c == null ? "—" : `${s.bed_c.toFixed(1)}°C`;

  const connected = s.connection === "connected";
  const enable = connected;
  for (const el of [
    jogXNeg,
    jogXPos,
    jogYNeg,
    jogYPos,
    jogZUp,
    jogZDown,
    homeBtn,
    g29Btn,
    pidHotendBtn,
    pidBedBtn,
  ]) {
    if (el) el.disabled = !enable;
  }

  // Drive toolpath progress highlighting
  try {
    if (
      toolpathState.data &&
      toolpathState.filename &&
      selectedFilename &&
      toolpathState.filename === selectedFilename &&
      s.job_file &&
      String(s.job_file) === String(selectedFilename) &&
      s.job_state &&
      s.job_state !== "idle" &&
      s.job_line != null
    ) {
      toolpathState.jobLine = Number(s.job_line);
      const layers = Array.isArray(toolpathState.data.layers) ? toolpathState.data.layers : [];
      if (!toolpathState.layerPinned && layers.length) {
        toolpathState.layerIndex = findLayerForLine(layers, toolpathState.jobLine);
        const slider = filePreview.querySelector(".toolpath-slider");
        if (slider) slider.value = String(toolpathState.layerIndex);
      }
      updateToolpathLayerLabel();
      redrawToolpath();
    }
  } catch {
    // ignore
  }

  // Animate only while actively printing the selected file.
  try {
    const anim =
      toolpathState.data &&
      toolpathState.canvas &&
      toolpathState.filename &&
      selectedFilename &&
      toolpathState.filename === selectedFilename &&
      s.job_file &&
      String(s.job_file) === String(selectedFilename) &&
      s.job_state === "printing" &&
      s.job_line != null;
    setToolpathAnimation(!!anim);
  } catch {
    setToolpathAnimation(false);
  }
}

function fmtAge(ts) {
  try {
    const sec = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    return `${min}min`;
  } catch {
    return "";
  }
}

async function refreshTimelapse() {
  let st;
  try {
    st = await api("/api/timelapse/status");
  } catch (e) {
    tlMeta.textContent = `Erro: ${e.message}`;
    return;
  }

  tlMeta.innerHTML = `
    <div class="kv"><span>Rodando:</span> <span>${st.running ? "sim" : "não"}</span></div>
    <div class="kv"><span>Frames:</span> <span>${st.frames || 0}</span></div>
    <div class="kv"><span>Intervalo:</span> <span>${st.interval_s}s</span></div>
    <div class="kv"><span>FPS:</span> <span>${st.fps}</span></div>
  `;

  // Last video shortcut
  if (st.last_video) {
    tlLastLink.style.pointerEvents = "auto";
    tlLastLink.style.opacity = "1";
    tlLastLink.href = `/api/timelapse/video/${encodeURIComponent(st.last_video)}`;
  } else {
    tlLastLink.style.pointerEvents = "none";
    tlLastLink.style.opacity = "0.5";
    tlLastLink.href = "#";
  }

  // Video list
  tlList.innerHTML = "";
  let vids = [];
  try {
    vids = await api("/api/timelapse/videos");
  } catch (e) {
    const el = document.createElement("div");
    el.className = "muted";
    el.textContent = `Erro ao listar vídeos: ${e.message}`;
    tlList.appendChild(el);
    return;
  }

  if (!vids.length) {
    const el = document.createElement("div");
    el.className = "muted";
    el.textContent = "Nenhum vídeo gerado ainda.";
    tlList.appendChild(el);
    return;
  }

  for (const v of vids.slice().reverse().slice(0, 10)) {
    const a = document.createElement("a");
    a.href = `/api/timelapse/video/${encodeURIComponent(v.name)}`;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.className = "timelapse-item";
    const kb = Math.max(1, Math.round((v.size_bytes || 0) / 1024));
    const age = v.mtime ? fmtAge(v.mtime) : "";
    a.textContent = `${v.name} — ${kb} KB${age ? " — " + age : ""}`;
    tlList.appendChild(a);
  }
}

let liveTimer;
function startLivePreview() {
  if (liveTimer) return;
  const tick = async () => {
    try {
      const url = `/api/timelapse/live?ts=${Date.now()}`;
      tlLiveImg.src = url;
      tlLiveImg.style.display = "block";
      tlLiveHint.style.display = "none";
    } catch {
      // ignore
    }
  };
  // Load immediately and then refresh.
  tick();
  liveTimer = setInterval(tick, 1000);
}

function stopLivePreview() {
  if (!liveTimer) return;
  clearInterval(liveTimer);
  liveTimer = undefined;
}

let ws;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    log("[ws] conectado");
    ws.send(JSON.stringify({ type: "poll" }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "serial") {
      log(msg.line);
    } else if (msg.type === "status") {
      renderStatus(msg.data);
    } else if (msg.type === "error") {
      log(`[erro] ${msg.message}`);
    }
  };

  ws.onclose = () => {
    log("[ws] desconectado; tentando novamente...");
    setTimeout(connectWs, 1000);
  };
}

refreshPortsBtn.onclick = async () => {
  try { await refreshPorts(); } catch (e) { log(`[erro] ${e.message}`); }
};

connectBtn.onclick = async () => {
  try {
    await api("/api/printer/connect", {
      method: "POST",
      body: JSON.stringify({ port: portSelect.value, baudrate: Number(baudInput.value || 115200) }),
    });
    log(`[printer] conectado em ${portSelect.value}`);
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

disconnectBtn.onclick = async () => {
  try {
    await api("/api/printer/disconnect", { method: "POST" });
    log("[printer] desconectado");
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

async function setTemperature({ hotend, bed }) {
  const payload = {};
  if (hotend != null) payload.hotend_c = hotend;
  if (bed != null) payload.bed_c = bed;
  await api("/api/printer/temperature", { method: "POST", body: JSON.stringify(payload) });
}

setTempBtn.onclick = async () => {
  try {
    const hot = hotendSet.value.trim() === "" ? null : Number(hotendSet.value);
    const bedv = bedSet.value.trim() === "" ? null : Number(bedSet.value);
    if (hot == null && bedv == null) throw new Error("Informe Hotend e/ou Bed");
    await setTemperature({ hotend: hot, bed: bedv });
    log(`[temp] aplicado: hotend=${hot == null ? "—" : hot}°C bed=${bedv == null ? "—" : bedv}°C`);
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

hotendOffBtn.onclick = async () => {
  try {
    await setTemperature({ hotend: 0, bed: null });
    log("[temp] hotend OFF");
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

bedOffBtn.onclick = async () => {
  try {
    await setTemperature({ hotend: null, bed: 0 });
    log("[temp] bed OFF");
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

allOffBtn.onclick = async () => {
  try {
    const ok = confirm("Desligar hotend e bed agora?");
    if (!ok) return;
    await setTemperature({ hotend: 0, bed: 0 });
    log("[temp] tudo OFF");
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

uploadBtn.onclick = async () => {
  const f = uploadInput.files?.[0];
  if (!f) return;
  try {
    const fd = new FormData();
    fd.append("file", f);
    await api("/api/files/upload", { method: "POST", body: fd });
    log(`[files] upload ok: ${f.name}`);
    await refreshFiles();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

refreshFilesBtn.onclick = async () => {
  try { await refreshFiles(); } catch (e) { log(`[erro] ${e.message}`); }
};

deleteFileBtn.onclick = async () => {
  try {
    if (!selectedFilename) throw new Error("Selecione um arquivo .gcode");
    const ok = confirm(`Excluir definitivamente o arquivo?\n\n${selectedFilename}`);
    if (!ok) return;

    await api(`/api/files/${encodeURIComponent(selectedFilename)}`, { method: "DELETE" });
    log(`[files] excluído: ${selectedFilename}`);
    selectedFilename = "";
    selectedFile.textContent = "—";
    filePreview.innerHTML = '<div class="muted">Selecione um arquivo para ver a prévia.</div>';
    await refreshFiles();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

startBtn.onclick = async () => {
  try {
    if (!selectedFilename) throw new Error("Selecione um arquivo .gcode")
    await api("/api/job/start", { method: "POST", body: JSON.stringify({ filename: selectedFilename }) });
    log(`[job] iniciado: ${selectedFilename}`);
    ws?.send(JSON.stringify({ type: "poll" }));
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

pauseBtn.onclick = async () => {
  try { await api("/api/job/pause", { method: "POST" }); log("[job] pausado"); } catch (e) { log(`[erro] ${e.message}`); }
};

resumeBtn.onclick = async () => {
  try { await api("/api/job/resume", { method: "POST" }); log("[job] retomado"); } catch (e) { log(`[erro] ${e.message}`); }
};

cancelBtn.onclick = async () => {
  try { await api("/api/job/cancel", { method: "POST" }); log("[job] cancelado"); } catch (e) { log(`[erro] ${e.message}`); }
};

sendBtn.onclick = async () => {
  const c = cmdInput.value.trim();
  if (!c) return;
  try {
    ws?.send(JSON.stringify({ type: "send", command: c }));
    log(`> ${c}`);
    cmdInput.value = "";
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

pollBtn.onclick = async () => {
  ws?.send(JSON.stringify({ type: "poll" }));
};

tlStartBtn.onclick = async () => {
  try {
    await api("/api/timelapse/start", { method: "POST", body: JSON.stringify({ label: selectedFilename || "timelapse" }) });
    log("[timelapse] iniciado");
    await refreshTimelapse();
    startLivePreview();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

tlStopBtn.onclick = async () => {
  try {
    await api("/api/timelapse/stop", { method: "POST" });
    log("[timelapse] parado (gerando vídeo)");
    await refreshTimelapse();
    // Keep showing last frame; stop polling to reduce load.
    stopLivePreview();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

tlRefreshBtn.onclick = async () => {
  try {
    await refreshTimelapse();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
};

(async function boot() {
  try {
    setActiveTab("print");
    await refreshPorts();
    await refreshFiles();
    await refreshTimelapse();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
  connectWs();
  // Start live preview only if timelapse is already running
  try {
    const st = await api("/api/timelapse/status");
    if (st.running) startLivePreview();
  } catch {}
})();

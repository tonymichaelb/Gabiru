const $ = (id) => document.getElementById(id);

const terminal = $("terminal");
const connStatus = $("connStatus");

const portSelect = $("portSelect");
const baudInput = $("baudInput");
const refreshPortsBtn = $("refreshPortsBtn");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");

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

let selectedFilename = "";

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

      const big = document.createElement("img");
      big.className = "preview-img";
      big.alt = "Prévia do G-code";
      big.src = thumbUrl;
      big.onerror = () => {
        filePreview.innerHTML = '<div class="muted">Este G-code não tem thumbnail embutido.</div>';
      };
      filePreview.innerHTML = "";
      filePreview.appendChild(big);
    };

    fileList.appendChild(item);
  }
}

function renderStatus(s) {
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

(async function boot() {
  try {
    await refreshPorts();
    await refreshFiles();
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
  connectWs();
})();

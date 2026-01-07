// ========== Authentication ==========

async function checkAuth() {
  const token = localStorage.getItem('chroma_token');
  
  // Check if system requires authentication
  try {
    const statusRes = await fetch('/api/auth/status');
    const statusData = await statusRes.json();
    
    // No users = setup mode, no auth required
    if (!statusData.has_users) {
      return true;
    }
    
    // Users exist, need valid token
    if (!token) {
      window.location.href = '/static/login.html';
      return false;
    }
    
    // Validate token
    const meRes = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!meRes.ok) {
      // Invalid token, redirect to login
      localStorage.removeItem('chroma_token');
      window.location.href = '/static/login.html';
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Auth check failed:', err);
    return true; // Allow access on error (graceful degradation)
  }
}

// Helper to make authenticated requests
function authFetch(url, options = {}) {
  const token = localStorage.getItem('chroma_token');
  if (token) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(url, options);
}

// Helper to make authenticated requests with the same error handling as api()
async function authApi(path, opts = {}) {
  const res = await authFetch(path, {
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

// ========== DOM Elements ==========

const $ = (id) => document.getElementById(id);

const terminal = $("terminal");
const connStatus = $("connStatus");

const tabPrint = $("tabPrint");
const tabMotion = $("tabMotion");
const tabColorir = $("tabColorir");
const tabSystem = $("tabSystem");
const panelPrint = $("panelPrint");
const panelMotion = $("panelMotion");
const panelColorir = $("panelColorir");
const panelSystem = $("panelSystem");

const filamentStatusLabel = $("filamentStatusLabel");

const pincelButtons = $("pincelButtons");
const tintaButtons = $("tintaButtons");

const tintaMixSelected = $("tintaMixSelected");
const mixTotal = $("mixTotal");
const mixA = $("mixA");
const mixB = $("mixB");
const mixC = $("mixC");
const mixApplyBtn = $("mixApplyBtn");

let selectedPincelTool = null;
let selectedTintaId = null;

const TINTA_COLORS = {
  1: "#0000FF",
  2: "#FF0000",
  3: "#FFFF00",
  4: "#000080",
  5: "#00FFFF",
  6: "#00FF00",
  7: "#BFFF00",
  8: "#C0C0C0",
  9: "#FFA500",
  10: "#FF8C00",
  11: "#FFD27F",
  12: "#800000",
  13: "#800080",
  14: "#964B00",
  15: "#E12400",
  16: "#006400",
  17: "#404040",
  18: "#808080",
  19: "#FF00FF",
};

function tintaStorageKey(n) {
  return `chroma_tinta_color_${n}`;
}

function tintaMixStorageKey(n) {
  return `chroma_tinta_mix_${n}`;
}

function parseM182ToMix(gcode) {
  const s = String(gcode || "");
  const ma = /\bA\s*(-?\d+(?:\.\d+)?)\b/i.exec(s);
  const mb = /\bB\s*(-?\d+(?:\.\d+)?)\b/i.exec(s);
  const mc = /\bC\s*(-?\d+(?:\.\d+)?)\b/i.exec(s);
  const a = ma ? Math.round(Number(ma[1])) : null;
  const b = mb ? Math.round(Number(mb[1])) : null;
  const c = mc ? Math.round(Number(mc[1])) : null;
  if (![a, b, c].every((v) => Number.isFinite(v))) return null;
  return {
    a: Math.max(0, Math.min(100, a)),
    b: Math.max(0, Math.min(100, b)),
    c: Math.max(0, Math.min(100, c)),
  };
}

function getTintaMix(n) {
  const saved = localStorage.getItem(tintaMixStorageKey(n));
  if (saved) {
    try {
      const obj = JSON.parse(saved);
      const a = Number(obj?.a);
      const b = Number(obj?.b);
      const c = Number(obj?.c);
      if ([a, b, c].every((v) => Number.isFinite(v))) {
        return {
          a: Math.max(0, Math.min(100, Math.round(a))),
          b: Math.max(0, Math.min(100, Math.round(b))),
          c: Math.max(0, Math.min(100, Math.round(c))),
        };
      }
    } catch {}
  }

  // Default: parse from current button's data-gcode (ships with initial mixes)
  if (tintaButtons) {
    const btn = tintaButtons.querySelector(`button[data-tinta-id="${n}"]`);
    const g = btn?.getAttribute?.("data-gcode");
    const mix = parseM182ToMix(g);
    if (mix) return mix;
  }

  return { a: 33, b: 33, c: 33 };
}

function setTintaMix(n, mix) {
  const a = Number(mix?.a);
  const b = Number(mix?.b);
  const c = Number(mix?.c);
  if (![a, b, c].every((v) => Number.isFinite(v))) return;
  const obj = {
    a: Math.max(0, Math.min(100, Math.round(a))),
    b: Math.max(0, Math.min(100, Math.round(b))),
    c: Math.max(0, Math.min(100, Math.round(c))),
  };
  localStorage.setItem(tintaMixStorageKey(n), JSON.stringify(obj));
}

function buildM182FromMix(mix) {
  const a = Math.max(0, Math.min(100, Math.round(Number(mix?.a))));
  const b = Math.max(0, Math.min(100, Math.round(Number(mix?.b))));
  const c = Math.max(0, Math.min(100, Math.round(Number(mix?.c))));
  return `M182 A${a} B${b} C${c}`;
}

function syncMixUi() {
  if (!tintaMixSelected || !mixA || !mixB || !mixC) return;
  if (selectedTintaId == null) {
    tintaMixSelected.textContent = "—";
    if (mixTotal) mixTotal.textContent = "—";
    return;
  }
  tintaMixSelected.textContent = String(selectedTintaId);
  const mix = getTintaMix(selectedTintaId);
  mixA.value = String(mix.a);
  mixB.value = String(mix.b);
  mixC.value = String(mix.c);
  updateMixTotal();
}

function updateMixTotal() {
  if (!mixTotal) return;
  const a = Math.round(Number(mixA?.value));
  const b = Math.round(Number(mixB?.value));
  const c = Math.round(Number(mixC?.value));
  if (![a, b, c].every((v) => Number.isFinite(v))) {
    mixTotal.textContent = "—";
    return;
  }
  const total = a + b + c;
  mixTotal.textContent = `${total}%${total === 100 ? "" : " (ajuste)"}`;
}

if (mixA) mixA.oninput = updateMixTotal;
if (mixB) mixB.oninput = updateMixTotal;
if (mixC) mixC.oninput = updateMixTotal;

function getTintaColor(n) {
  const key = tintaStorageKey(n);
  const saved = localStorage.getItem(key);
  if (saved && /^#([0-9a-fA-F]{6})$/.test(saved.trim())) return saved.trim();
  return TINTA_COLORS[n] || "#ffffff";
}

function setTintaColor(n, hex) {
  const v = String(hex || "").trim();
  if (!/^#([0-9a-fA-F]{6})$/.test(v)) return;
  localStorage.setItem(tintaStorageKey(n), v);
}

function pincelStorageKey(tool) {
  return `chroma_pincel_color_${tool}`;
}

function getPincelColor(tool) {
  const saved = localStorage.getItem(pincelStorageKey(tool));
  if (saved && /^#([0-9a-fA-F]{6})$/.test(saved.trim())) return saved.trim();
  return null;
}

function setPincelColor(tool, hex) {
  const v = String(hex || "").trim();
  if (!/^#([0-9a-fA-F]{6})$/.test(v)) return;
  localStorage.setItem(pincelStorageKey(tool), v);
}

function applyButtonColor(btn, hex) {
  if (!btn) return;
  const h = String(hex || "").trim();
  if (!h) return;

  btn.style.backgroundColor = h;

  const rgb = parseCssColorToRgb(h);
  if (!rgb) {
    btn.style.color = "#fff";
    return;
  }
  const { r, g, b } = rgb;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  btn.style.color = lum > 150 ? "#000" : "#fff";
}

function setPincelButtonColors() {
  if (!pincelButtons) return;
  const buttons = pincelButtons.querySelectorAll("button[data-pincel-tool]");
  buttons.forEach((btn) => {
    const tool = Number(btn.getAttribute("data-pincel-tool"));
    if (!Number.isFinite(tool) || tool < 0 || tool > 18) return;
    const hex = getPincelColor(tool);
    if (!hex) return;
    applyButtonColor(btn, hex);
  });
}

function parseCssColorToRgb(color) {
  const s = String(color || "").trim();

  let m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    return { r, g, b };
  }

  m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s);
  if (m) {
    const rgb = m[1];
    const r = parseInt(rgb.slice(0, 2), 16);
    const g = parseInt(rgb.slice(2, 4), 16);
    const b = parseInt(rgb.slice(4, 6), 16);
    return { r, g, b };
  }

  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d*\.?\d+)\s*)?\)$/.exec(s);
  if (m) {
    const r = Math.max(0, Math.min(255, Number(m[1])));
    const g = Math.max(0, Math.min(255, Number(m[2])));
    const b = Math.max(0, Math.min(255, Number(m[3])));
    return { r, g, b };
  }

  return null;
}

function setTintaButtonColors() {
  if (!tintaButtons) return;

  const buttons = tintaButtons.querySelectorAll("button.round-btn");
  buttons.forEach((btn) => {
    const n = Number(btn.getAttribute("data-tinta-id") || String(btn.textContent || "").trim());
    if (!Number.isFinite(n) || n < 1 || n > 19) return;
    const hex = getTintaColor(n);

    btn.style.backgroundColor = hex;

    // Force size inline as well (helps when CSS is cached/not applying).
    btn.style.width = "56px";
    btn.style.height = "56px";
    btn.style.minWidth = "56px";
    btn.style.fontSize = "14px";

    // Choose text color (black/white) based on luminance for readability.
    const rgb = parseCssColorToRgb(hex);
    if (!rgb) {
      btn.style.color = "#fff";
      return;
    }
    const { r, g, b } = rgb;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    btn.style.color = lum > 150 ? "#000" : "#fff";

    const picker = tintaButtons.querySelector(`input.tinta-color[data-tinta-id="${n}"]`);
    if (picker && picker.value !== hex) picker.value = hex;
  });
}

const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const fixedPortLabel = $("fixedPortLabel");
const updateNowBtn = $("updateNowBtn");
const updateLog = $("updateLog");

const wifiStatusLabel = $("wifiStatusLabel");
const wifiScanBtn = $("wifiScanBtn");
const wifiSsidSelect = $("wifiSsidSelect");
const wifiPassword = $("wifiPassword");
const wifiConnectBtn = $("wifiConnectBtn");

const FIXED_SERIAL_PORT = "/dev/ttyACM0";
const FIXED_BAUDRATE = 115200;

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

const extruderTool = $("extruderTool");
const extrudeAmount = $("extrudeAmount");
const extrudeSpeed = $("extrudeSpeed");
const extrudeBtn = $("extrudeBtn");
const retractBtn = $("retractBtn");

const updateBanner = $("updateBanner");
const updateBannerText = $("updateBannerText");
const updateReloadBtn = $("updateReloadBtn");

const footerVersion = $("footerVersion");
const toastHost = $("toastHost");

// Account / Users
const accountUserLabel = $("accountUserLabel");
const accountHint = $("accountHint");
const logoutBtn = $("logoutBtn");
const pwCurrent = $("pwCurrent");
const pwNew = $("pwNew");
const pwNewConfirm = $("pwNewConfirm");
const changePwBtn = $("changePwBtn");
const newUserName = $("newUserName");
const newUserPw = $("newUserPw");
const newUserPwConfirm = $("newUserPwConfirm");
const createUserBtn = $("createUserBtn");
const resetUsersBtn = $("resetUsersBtn");

function setAccountUiEnabled(enabled, username) {
  const on = !!enabled;
  if (accountUserLabel) accountUserLabel.textContent = `Usuário: ${username || "—"}`;
  if (accountHint) accountHint.style.display = on ? "none" : "block";

  const controls = [
    logoutBtn,
    pwCurrent,
    pwNew,
    pwNewConfirm,
    changePwBtn,
    newUserName,
    newUserPw,
    newUserPwConfirm,
    createUserBtn,
    resetUsersBtn,
  ];
  for (const el of controls) {
    if (!el) continue;
    el.disabled = !on;
  }
}

async function initAccountUi() {
  // In setup mode (no users) we might not have a token.
  const token = localStorage.getItem("chroma_token");
  if (!token) {
    setAccountUiEnabled(false);
    return;
  }
  try {
    const me = await authApi("/api/auth/me");
    setAccountUiEnabled(true, me?.username);
  } catch {
    setAccountUiEnabled(false);
  }
}

let selectedFilename = "";

let lastStatus;

let updateBaselineKey;

function setFooterVersionText({ version, build } = {}) {
  if (!footerVersion) return;

  const v = version ? String(version).trim() : "";
  const b = build ? String(build).trim() : "";

  if (!v && !b) {
    footerVersion.textContent = "versão —";
    return;
  }

  const parts = [];
  if (v) parts.push(`v${v}`);
  if (b) parts.push(String(b));
  footerVersion.textContent = `versão ${parts.join(" • ")}`;
}

let toolpathState = {
  filename: "",
  data: null,
  canvas: null,
  layerIndex: 0,
  layerPinned: false,
  jobLine: null,
  inspectLine: null,
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
  const isColorir = name === "colorir";
  const isSystem = name === "system";

  tabPrint.classList.toggle("active", isPrint);
  tabMotion.classList.toggle("active", isMotion);
  tabColorir.classList.toggle("active", isColorir);
  tabSystem.classList.toggle("active", isSystem);

  panelPrint.classList.toggle("hidden", !isPrint);
  panelMotion.classList.toggle("hidden", !isMotion);
  panelColorir.classList.toggle("hidden", !isColorir);
  panelSystem.classList.toggle("hidden", !isSystem);

  // Live preview is shown on the Print tab.
  if (isPrint) startLivePreview();
  else stopLivePreview();
}

tabPrint.onclick = () => setActiveTab("print");
tabMotion.onclick = () => setActiveTab("motion");
tabColorir.onclick = () => setActiveTab("colorir");
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

      setFooterVersionText({ version: ver, build });

      const key = `${ver == null ? "" : String(ver)}|${build == null ? "" : String(build)}`;
      if (updateBaselineKey === undefined) {
        updateBaselineKey = key;
        return;
      }

      if (key !== updateBaselineKey) {
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

if (updateNowBtn) {
  updateNowBtn.onclick = async () => {
    updateNowBtn.disabled = true;
    try {
      if (updateLog) updateLog.textContent = "[atualização] iniciando...\n";
      await api("/api/update", { method: "POST", body: JSON.stringify({}) });
      notify("warn", "Atualização iniciada. Aguarde ~30s e recarregue a página.");
    } catch (e) {
      // If the service restarts mid-request, the fetch may fail; treat that as "probably updating".
      const msg = String(e?.message || e || "");
      if (msg && (msg.includes("Failed to fetch") || msg.includes("NetworkError"))) {
        notify("warn", "Atualização iniciada. Aguarde ~30s e recarregue a página.");
      } else {
        notify("error", `Falha ao atualizar: ${msg || "erro"}`);
      }
    } finally {
      setTimeout(() => {
        updateNowBtn.disabled = false;
      }, 4000);
    }

    // Show update progress (best-effort)
    if (updateLog) {
      const startedAt = Date.now();
      const tick = async () => {
        try {
          const res = await api("/api/update/log");
          const text = res && typeof res === "object" ? String(res.log || "") : "";
          updateLog.textContent = text;
        } catch {}

        // Poll for ~90s (the service may restart the app mid-way)
        if (Date.now() - startedAt < 90_000) {
          setTimeout(tick, 1000);
        }
      };
      tick();
    }
  };
}

async function fetchWifiStatus() {
  if (!wifiStatusLabel) return null;
  try {
    const st = await api("/api/wifi/status");
    if (!st?.available) {
      wifiStatusLabel.textContent = "Status: Wi‑Fi indisponível (nmcli não encontrado)";
      return st;
    }
    const ip = st.ip4 ? ` (${st.ip4})` : "";
    if (st.connected && st.ssid) {
      wifiStatusLabel.textContent = `Status: conectado em ${st.ssid}${ip}`;
    } else if (st.hotspot_active) {
      wifiStatusLabel.textContent = `Status: hotspot ativo (${st.hotspot_ssid})${ip}`;
    } else {
      wifiStatusLabel.textContent = `Status: desconectado${ip}`;
    }
    return st;
  } catch {
    wifiStatusLabel.textContent = "Status: —";
    return null;
  }
}

async function wifiScan() {
  if (!wifiSsidSelect) return;
  wifiSsidSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(selecione uma rede)";
  wifiSsidSelect.appendChild(placeholder);

  const res = await api("/api/wifi/scan", { method: "POST", body: JSON.stringify({}) });
  const nets = Array.isArray(res?.networks) ? res.networks : [];
  for (const n of nets) {
    const opt = document.createElement("option");
    opt.value = n.ssid;
    const sec = n.security && n.security !== "open" ? ` • ${n.security}` : "";
    const sig = Number.isFinite(n.signal) ? ` • ${n.signal}%` : "";
    opt.textContent = `${n.ssid}${sig}${sec}`;
    wifiSsidSelect.appendChild(opt);
  }
}

if (wifiScanBtn && wifiConnectBtn) {
  wifiScanBtn.onclick = async () => {
    wifiScanBtn.disabled = true;
    try {
      await fetchWifiStatus();
      await wifiScan();
      notify("ok", "Lista de redes atualizada.");
    } catch (e) {
      notify("error", `Falha ao buscar redes: ${String(e?.message || e || "erro")}`);
    } finally {
      wifiScanBtn.disabled = false;
    }
  };

  wifiConnectBtn.onclick = async () => {
    const ssid = String(wifiSsidSelect?.value || "").trim();
    const password = String(wifiPassword?.value || "");
    if (!ssid) {
      notify("error", "Selecione uma rede Wi‑Fi.");
      return;
    }

    wifiConnectBtn.disabled = true;
    try {
      await api("/api/wifi/connect", {
        method: "POST",
        body: JSON.stringify({ ssid, password: password || null }),
      });
      notify(
        "warn",
        "Conectando... se você estiver no hotspot, a conexão pode cair. Depois acesse pelo IP na nova rede."
      );
      setTimeout(fetchWifiStatus, 2500);
    } catch (e) {
      notify("error", `Falha ao conectar: ${String(e?.message || e || "erro")}`);
    } finally {
      setTimeout(() => {
        wifiConnectBtn.disabled = false;
      }, 4000);
    }
  };
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

if (pincelButtons) {
  pincelButtons.onclick = (ev) => {
    const btn = ev?.target?.closest?.("button[data-pincel-tool]");
    if (!btn) return;

    const tool = Number(btn.getAttribute("data-pincel-tool"));
    if (!Number.isFinite(tool) || tool < 0 || tool > 18) {
      notify("error", "Pincel inválido (use 0 a 18).");
      return;
    }

    selectedPincelTool = tool;
    const all = pincelButtons.querySelectorAll("button[data-pincel-tool]");
    all.forEach((b) => b.classList.toggle("active", b === btn));

    // Do not carry the last selected tinta to another pincel.
    selectedTintaId = null;
    if (tintaButtons) {
      const tbuttons = tintaButtons.querySelectorAll("button[data-gcode]");
      tbuttons.forEach((b) => b.classList.remove("active"));
    }

    wsSend(`T${Math.round(tool)}`);
  };
}

if (tintaButtons) {
  tintaButtons.onclick = (ev) => {
    const btn = ev?.target?.closest?.("button[data-gcode]");
    if (!btn) return;

    const tintaId = Number(btn.getAttribute("data-tinta-id") || String(btn.textContent || "").trim());
    if (Number.isFinite(tintaId) && tintaId >= 1 && tintaId <= 19) {
      selectedTintaId = tintaId;
      syncMixUi();
    }

    // Use per-tinta mix if configured.
    const mix = getTintaMix(selectedTintaId);
    const gcode = buildM182FromMix(mix);
    btn.setAttribute("data-gcode", gcode);
    if (!gcode) return;

    const buttons = tintaButtons.querySelectorAll("button[data-gcode]");
    buttons.forEach((b) => b.classList.toggle("active", b === btn));

    wsSend(gcode);

    if (selectedPincelTool != null && selectedTintaId != null && pincelButtons) {
      const pincelBtn = pincelButtons.querySelector(`button[data-pincel-tool="${selectedPincelTool}"]`);
      const hex = getTintaColor(selectedTintaId);
      setPincelColor(selectedPincelTool, hex);
      applyButtonColor(pincelBtn, hex);
    }
  };

  tintaButtons.oninput = (ev) => {
    const input = ev?.target?.closest?.("input.tinta-color[data-tinta-id]");
    if (!input) return;

    const n = Number(input.getAttribute("data-tinta-id"));
    const hex = String(input.value || "").trim();
    if (!Number.isFinite(n) || n < 1 || n > 19) return;
    if (!/^#([0-9a-fA-F]{6})$/.test(hex)) return;

    selectedTintaId = n;
    syncMixUi();
    setTintaColor(n, hex);
    setTintaButtonColors();

    if (selectedPincelTool != null && pincelButtons) {
      const pincelBtn = pincelButtons.querySelector(`button[data-pincel-tool="${selectedPincelTool}"]`);
      setPincelColor(selectedPincelTool, hex);
      applyButtonColor(pincelBtn, hex);
    }
  };
}

if (mixApplyBtn) {
  mixApplyBtn.onclick = () => {
    if (selectedTintaId == null) {
      notify("error", "Selecione uma tinta (1–19) primeiro.");
      return;
    }

    const a = Number(mixA?.value);
    const b = Number(mixB?.value);
    const c = Number(mixC?.value);
    if (![a, b, c].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) {
      notify("error", "Valores inválidos. Use 0 a 100.");
      return;
    }

    const ai = Math.round(a);
    const bi = Math.round(b);
    const ci = Math.round(c);
    const total = ai + bi + ci;
    if (total !== 100) {
      notify("error", `O total deve ser 100%. Atual: ${total}%.`);
      return;
    }

    setTintaMix(selectedTintaId, { a: ai, b: bi, c: ci });

    if (tintaButtons) {
      const btn = tintaButtons.querySelector(`button[data-tinta-id="${selectedTintaId}"]`);
      if (btn) btn.setAttribute("data-gcode", buildM182FromMix({ a: ai, b: bi, c: ci }));
    }
    notify("ok", `Mistura aplicada na tinta ${selectedTintaId}.`);
  };
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

function extrudeRelative(mm, mmPerS, toolIndex = 0) {
  const dist = Number(mm);
  const speed = Number(mmPerS);
  const tool = Number(toolIndex);
  if (!Number.isFinite(dist) || dist === 0) return log("[erro] Distância inválida");
  if (!Number.isFinite(speed) || speed <= 0) return log("[erro] Velocidade inválida");
  if (!Number.isFinite(tool) || tool < 0 || tool > 18) return log("[erro] Extrusor inválido (use 0 a 18)");
  // Use relative positioning and relative extruder, then restore defaults.
  const feed = Math.round(speed * 60); // mm/s -> mm/min

  const cmds = [`T${Math.round(tool)}`, "G91", "M83", `G1 E${dist.toFixed(2)} F${feed}`, "M82", "G90"];
  // Tool change can take a moment on some firmwares.
  wsSendMany(cmds, 120);
}

if (extrudeBtn) {
  extrudeBtn.onclick = () => {
    extrudeRelative(extrudeAmount?.value || 10, extrudeSpeed?.value || 5, extruderTool?.value || 0);
  };
}

if (retractBtn) {
  retractBtn.onclick = () => {
    const amt = Number(extrudeAmount?.value || 10);
    extrudeRelative(-amt, extrudeSpeed?.value || 5, extruderTool?.value || 0);
  };
}

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

function notify(type, message) {
  if (!toastHost) return;
  const t = String(type || "").toLowerCase();
  const text = String(message || "").trim();
  if (!text) return;

  // Keep it minimal: only errors and warnings.
  if (t !== "error" && t !== "warn") return;

  const el = document.createElement("div");
  el.className = `toast toast-${t}`;

  const msg = document.createElement("div");
  msg.className = "toast-msg";
  msg.textContent = text;
  el.appendChild(msg);

  el.title = "Clique para fechar";
  el.onclick = () => el.remove();

  toastHost.appendChild(el);

  // Auto-dismiss.
  const ttl = t === "error" ? 9000 : 6000;
  setTimeout(() => {
    if (el.isConnected) el.remove();
  }, ttl);
}

function log(line) {
  const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 20;
  terminal.textContent += line + "\n";
  if (atBottom) terminal.scrollTop = terminal.scrollHeight;

  const s = String(line || "");
  if (s.startsWith("[erro]")) {
    notify("error", s.replace(/^\[erro\]\s*/i, ""));
  } else if (s.startsWith("[ws] desconectado")) {
    notify("warn", "Conexão WebSocket caiu; reconectando...");
  }
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
    inspectLine: null,
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

  const lineLabel = document.createElement("div");
  lineLabel.className = "muted";
  lineLabel.id = "toolpathLineLabel";
  lineLabel.style.cursor = "pointer";
  lineLabel.title = "Clique para voltar a seguir a impressão";
  lineLabel.onclick = () => {
    toolpathState.inspectLine = null;
    syncToolpathLineControls();
    redrawToolpath();
  };
  controls.appendChild(lineLabel);

  const lineSlider = document.createElement("input");
  lineSlider.type = "range";
  lineSlider.id = "toolpathLineSlider";
  lineSlider.className = "toolpath-slider";
  lineSlider.step = "1";
  lineSlider.oninput = () => {
    toolpathState.inspectLine = Number(lineSlider.value || 0);
    updateToolpathLineLabel();
    redrawToolpath();
  };
  controls.appendChild(lineSlider);

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
    layerSlider.id = "toolpathLayerSlider";
    layerSlider.min = "0";
    layerSlider.max = String(layers.length - 1);
    layerSlider.step = "1";
    layerSlider.value = String(toolpathState.layerIndex || 0);
    layerSlider.className = "toolpath-slider";

    layerSlider.oninput = () => {
      toolpathState.layerPinned = true;
      toolpathState.layerIndex = Number(layerSlider.value || 0);
      updateToolpathLayerLabel();
      syncToolpathLineControls();
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
  syncToolpathLineControls();
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

function getToolpathMaxLine(data) {
  const segs = Array.isArray(data?.segments) ? data.segments : [];
  let maxLine = 0;
  for (const s of segs) {
    const ln = Number(s?.line ?? 0);
    if (Number.isFinite(ln)) maxLine = Math.max(maxLine, ln);
  }
  return maxLine;
}

function getToolpathLineRange(data) {
  const layers = Array.isArray(data?.layers) ? data.layers : [];
  if (layers.length) {
    const idx = Math.min(Math.max(0, toolpathState.layerIndex || 0), layers.length - 1);
    const start = Number(layers[idx]?.start_line ?? 0);
    const end = Number(layers[idx]?.end_line ?? start);
    const min = Number.isFinite(start) ? start : 0;
    const max = Number.isFinite(end) ? Math.max(min, end) : min;
    return { min, max };
  }
  return { min: 0, max: getToolpathMaxLine(data) };
}

function syncToolpathLineControls() {
  const data = toolpathState.data;
  if (!data) return;

  const slider = document.getElementById("toolpathLineSlider");
  if (!slider) return;

  const r = getToolpathLineRange(data);
  slider.min = String(r.min);
  slider.max = String(r.max);
  slider.disabled = r.max <= r.min;

  const clamp = (v) => Math.min(r.max, Math.max(r.min, Number(v)));
  if (toolpathState.inspectLine == null) {
    const base = toolpathState.jobLine != null ? toolpathState.jobLine : r.min;
    slider.value = String(clamp(base));
  } else {
    toolpathState.inspectLine = clamp(toolpathState.inspectLine);
    slider.value = String(toolpathState.inspectLine);
  }
  updateToolpathLineLabel();
}

function updateToolpathLineLabel() {
  const data = toolpathState.data;
  if (!data) return;
  const label = document.getElementById("toolpathLineLabel");
  if (!label) return;

  const r = getToolpathLineRange(data);
  const current = toolpathState.inspectLine != null ? toolpathState.inspectLine : toolpathState.jobLine;
  const manual = toolpathState.inspectLine != null;

  const curTxt = current == null ? "—" : String(Math.round(Number(current)));
  const hint = manual ? " • manual (clique para seguir impressão)" : "";
  label.textContent = `Linha: ${curTxt} (${r.min}–${r.max})${hint}`;
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
    uptoLine: toolpathState.inspectLine != null ? toolpathState.inspectLine : toolpathState.jobLine,
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
  strokeSegments(travelRest, { width: 0.9, color: "#334155" });
  strokeSegments(extrRest, { width: 1.6, color: "#64748b" });

  // Printed (darker/thicker)
  strokeSegments(travelPrinted, { width: 1.0, color: "#94a3b8" });
  strokeSegments(extrPrinted, { width: 2.2, color: "#e5e7eb" });

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

  if (fixedPortLabel) {
    fixedPortLabel.style.display = s.connection === "connected" ? "block" : "none";
  }

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
        const slider = document.getElementById("toolpathLayerSlider");
        if (slider) slider.value = String(toolpathState.layerIndex);
      }
      updateToolpathLayerLabel();
      if (toolpathState.inspectLine == null) syncToolpathLineControls();
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
  let failCount = 0;

  // If the camera isn't available, show the hint instead of a broken image.
  if (tlLiveImg) {
    tlLiveImg.onerror = () => {
      failCount += 1;
      tlLiveImg.style.display = "none";
      if (tlLiveHint) {
        tlLiveHint.style.display = "block";
        tlLiveHint.textContent = "Câmera indisponível. Verifique libcamera/fswebcam e permissões.";
      }
      if (failCount >= 3) stopLivePreview();
    };

    tlLiveImg.onload = () => {
      failCount = 0;
      tlLiveImg.style.display = "block";
      if (tlLiveHint) tlLiveHint.style.display = "none";
    };
  }

  const tick = async () => {
    try {
      const url = `/api/timelapse/live?ts=${Date.now()}`;
      tlLiveImg.src = url;
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
      notify("error", msg.message);
    }
  };

  ws.onclose = () => {
    log("[ws] desconectado; tentando novamente...");
    setTimeout(connectWs, 1000);
  };
}

connectBtn.onclick = async () => {
  try {
    await api("/api/printer/connect", {
      method: "POST",
      body: JSON.stringify({ port: FIXED_SERIAL_PORT, baudrate: FIXED_BAUDRATE }),
    });
    log(`[printer] conectado em ${FIXED_SERIAL_PORT}`);
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
  try {
    await api("/api/job/pause", { method: "POST" });
    log("[job] pausado");

    // Move head to a known safe spot after pausing.
    // Keep it minimal: only set XY to 5/5 (absolute mode).
    wsSendMany(["G90", "G1 X5 Y5 F6000"]);
  } catch (e) {
    log(`[erro] ${e.message}`);
  }
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

// ========== Filament sensor UI ==========

async function fetchFilamentStatus() {
  if (!filamentStatusLabel) return;
  try {
    const st = await api("/api/filament/status");
    if (!st || !st.supported) {
      filamentStatusLabel.textContent = "Status: indisponível";
      return;
    }
    if (st.has_filament === true) {
      filamentStatusLabel.textContent = "Status: com filamento";
      return;
    }
    if (st.has_filament === false) {
      filamentStatusLabel.textContent = "Status: sem filamento";
      return;
    }
    filamentStatusLabel.textContent = "Status: —";
  } catch {
    filamentStatusLabel.textContent = "Status: —";
  }
}

function startFilamentPolling() {
  if (!filamentStatusLabel) return;
  fetchFilamentStatus();
  setInterval(fetchFilamentStatus, 1000);
}

(async function boot() {
  // Check authentication first
  const authenticated = await checkAuth();
  if (!authenticated) return; // Will redirect to login
  
  try {
    setActiveTab("print");
    setTintaButtonColors();
    setPincelButtonColors();
    startUpdateWatcher();
    fetchWifiStatus();
    setInterval(fetchWifiStatus, 10_000);
    startFilamentPolling();
    await initAccountUi();
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

// ========== Account actions ==========

if (logoutBtn) {
  logoutBtn.onclick = () => {
    localStorage.removeItem("chroma_token");
    window.location.href = "/static/login.html";
  };
}

if (changePwBtn) {
  changePwBtn.onclick = async () => {
    try {
      const current = String(pwCurrent?.value || "");
      const next = String(pwNew?.value || "");
      const confirm = String(pwNewConfirm?.value || "");
      await authApi("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: current,
          new_password: next,
          new_password_confirm: confirm,
        }),
      });
      if (pwCurrent) pwCurrent.value = "";
      if (pwNew) pwNew.value = "";
      if (pwNewConfirm) pwNewConfirm.value = "";
      notify("warn", "Senha trocada com sucesso.");
    } catch (e) {
      notify("error", `Falha ao trocar senha: ${String(e?.message || e || "erro")}`);
    }
  };
}

if (createUserBtn) {
  createUserBtn.onclick = async () => {
    try {
      const username = String(newUserName?.value || "").trim();
      const password = String(newUserPw?.value || "");
      const password_confirm = String(newUserPwConfirm?.value || "");

      await authApi("/api/auth/users", {
        method: "POST",
        body: JSON.stringify({ username, password, password_confirm }),
      });

      if (newUserName) newUserName.value = "";
      if (newUserPw) newUserPw.value = "";
      if (newUserPwConfirm) newUserPwConfirm.value = "";
      notify("warn", "Usuário criado com sucesso.");
    } catch (e) {
      notify("error", `Falha ao criar usuário: ${String(e?.message || e || "erro")}`);
    }
  };
}

if (resetUsersBtn) {
  resetUsersBtn.onclick = async () => {
    try {
      await authApi("/api/auth/reset-users", { method: "POST", body: JSON.stringify({}) });
      localStorage.removeItem("chroma_token");
      window.location.href = "/static/login.html";
    } catch (e) {
      notify("error", `Falha ao resetar usuários: ${String(e?.message || e || "erro")}`);
    }
  };
}

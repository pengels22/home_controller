function $(id) { return document.getElementById(id); }

// cache: moduleId -> { type, svgRoot }
const MODULE_SVGS = new Map();

let MODAL_CTX = {
  id: null,
  type: null,
  address: null,
  name: null
};

// --------------------
// Test mode (cycle channels across all modules)
// --------------------
let TEST_RUNNING = false;

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _setTestBtn(on) {
  const b = $("test_btn");
  if (!b) return;
  b.textContent = on ? "Stop Test" : "Test";
}

function _allLedOff() {
  for (const [_mid, info] of MODULE_SVGS.entries()) {
    const root = info.svgRoot;
    if (!root) continue;

    // Turn off any that were turned on
    const ons = root.querySelectorAll(".led-on");
    ons.forEach((el) => {
      el.classList.remove("led-on");
      el.classList.add("led-off");
    });

    // Also ensure every channel group is at least "off" once (helps initial state)
    for (let ch = 1; ch <= 16; ch++) {
      const el = _findLedElement(info.type, root, ch);
      if (el) {
        el.classList.remove("led-on");
        el.classList.add("led-off");
      }
    }
  }
}

/**
 * Finds the LED "group" element for a channel.
 * Supports:
 *  - ch01..ch16 (your current SVGs)
 *  - ch1..ch16 (fallback)
 *  - aio: in1..in8 / out1..out8 (future fallback)
 */
function _findLedElement(moduleType, svgRoot, channelIndex) {
  if (!svgRoot) return null;

  const mt = String(moduleType || "").toLowerCase();

  // Preferred: ch01..ch16
  const id2 = `ch${String(channelIndex).padStart(2, "0")}`;
  let el = svgRoot.querySelector(`#${id2}`);
  if (el) return el;

  // Fallback: ch1..ch16
  const id1 = `ch${channelIndex}`;
  el = svgRoot.querySelector(`#${id1}`);
  if (el) return el;

  // Fallback: AIO in/out
  if (mt === "aio") {
    if (channelIndex >= 1 && channelIndex <= 8) {
      el = svgRoot.querySelector(`#in${channelIndex}`);
      if (el) return el;
    }
    if (channelIndex >= 9 && channelIndex <= 16) {
      el = svgRoot.querySelector(`#out${channelIndex - 8}`);
      if (el) return el;
    }
  }

  return null;
}

function _flashLed(el, on) {
  if (!el) return;
  if (on) {
    el.classList.add("led-on");
    el.classList.remove("led-off");
  } else {
    el.classList.remove("led-on");
    el.classList.add("led-off");
  }
}

async function runTestLoop() {
  TEST_RUNNING = true;
  _setTestBtn(true);

  _allLedOff();

  while (TEST_RUNNING) {
    for (const [_moduleId, info] of MODULE_SVGS.entries()) {
      if (!TEST_RUNNING) break;

      for (let ch = 1; ch <= 16; ch++) {
        if (!TEST_RUNNING) break;

        const el = _findLedElement(info.type, info.svgRoot, ch);
        _flashLed(el, true);
        await _sleep(250);
        _flashLed(el, false);
        await _sleep(80);
      }
    }
  }

  _allLedOff();
  _setTestBtn(false);
}

function toggleTest() {
  if (TEST_RUNNING) {
    TEST_RUNNING = false;
    _setTestBtn(false);
    _allLedOff();
    return;
  }
  runTestLoop();
}

// Expose for onclick="toggleTest()"
window.toggleTest = toggleTest;

// --------------------
// Status
// --------------------
async function loadStatus() {
  const el = $("status");
  if (!el) return;

  try {
    const res = await fetch("/");
    const data = await res.json();
    el.textContent = `RUNNING • Modules: ${data.modules}`;
    el.classList.remove("status-bad");
    el.classList.add("status-good");
  } catch (e) {
    el.textContent = "OFFLINE";
    el.classList.remove("status-good");
    el.classList.add("status-bad");
  }
}

// --------------------
// Modules list + SVG wiring
// --------------------
async function loadModules() {
  const row = $("modules");
  if (!row) return;

  const res = await fetch("/modules");
  const data = await res.json();

  row.innerHTML = "";
  MODULE_SVGS.clear(); // prevent stale svg references

  if (!data || data.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No modules configured yet.";
    row.appendChild(empty);
    return;
  }

  for (const m of data) {
    const card = document.createElement("div");
    card.className = "module-card";

    const header = document.createElement("div");
    header.className = "module-header";

    const left = document.createElement("div");

    // Name as main, type+address as sub
    const displayName =
      (m.name && String(m.name).trim().length > 0)
        ? String(m.name).trim()
        : `${String(m.type || "").toUpperCase()} MODULE`;

    left.innerHTML = `
      <div class="module-title">${displayName}</div>
      <div class="module-sub">${String(m.type || "").toUpperCase()} • ${m.address}</div>
    `;

    const gear = document.createElement("button");
    gear.className = "icon-btn";
    gear.title = "Settings";
    gear.textContent = "⚙️";
    gear.onclick = () => openModal(m);

    header.appendChild(left);
    header.appendChild(gear);

    const svgHolder = document.createElement("div");
    svgHolder.className = "module-svg";
    svgHolder.textContent = "Loading…";

    card.appendChild(header);
    card.appendChild(svgHolder);
    row.appendChild(card);

    // Inline SVG injection (so we can flip LEDs by class)
    try {
      const svgRes = await fetch(`/modules/svg/${m.type}`);
      if (!svgRes.ok) throw new Error("SVG not found");
      const svgText = await svgRes.text();
      svgHolder.innerHTML = svgText;

      const svgRoot = svgHolder.querySelector("svg");
      if (svgRoot) {
        MODULE_SVGS.set(m.id, { type: String(m.type).toLowerCase(), svgRoot });
      }
    } catch (e) {
      svgHolder.textContent = `No SVG for type: ${m.type}`;
      MODULE_SVGS.delete(m.id);
    }
  }
}

// --------------------
// Add page support
// --------------------
async function addModuleCore(type, addr, name) {
  const res = await fetch("/modules/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: type, address: addr, name: name }),
  });
  return await res.json();
}

async function addModuleThenGoBack() {
  const type = $("add_type")?.value || "";
  const addr = $("add_addr")?.value || "";
  const name = $("add_name")?.value || "";

  const errBox = $("add_error");
  if (errBox) { errBox.style.display = "none"; errBox.textContent = ""; }

  const data = await addModuleCore(type, addr, name);
  if (!data.ok) {
    if (errBox) {
      errBox.textContent = "Error: " + data.error;
      errBox.style.display = "block";
    } else {
      alert("Error: " + data.error);
    }
    return;
  }
  window.location.href = "/ui";
}

// Expose for onclick on add page
window.addModuleThenGoBack = addModuleThenGoBack;

// --------------------
// Modal (settings)
// --------------------
function closeModal() {
  const b = $("modal_backdrop");
  if (!b) return;
  b.style.display = "none";

  const err = $("modal_error");
  if (err) {
    err.style.display = "none";
    err.textContent = "";
  }

  MODAL_CTX = { id: null, type: null, address: null, name: null };
}

// Expose for onclick
window.closeModal = closeModal;

async function openModal(module) {
  MODAL_CTX = {
    id: module.id,
    type: module.type,
    address: module.address,
    name: module.name || ""
  };

  $("modal_title").textContent = `Settings • ${String(module.type || "").toUpperCase()}`;
  $("modal_sub").textContent = `${module.address} • ${module.id}`;

  $("modal_module_name").value = module.name || "";

  const grid = $("channels_grid");
  grid.innerHTML = "";

  for (let i = 1; i <= 16; i++) {
    const wrap = document.createElement("div");
    wrap.className = "channel-row";

    const lab = document.createElement("div");
    lab.className = "channel-label";
    lab.textContent = `CH ${i}`;

    const inp = document.createElement("input");
    inp.id = `ch_name_${i}`;
    inp.placeholder = `Name for channel ${i}`;
    inp.className = "channel-input";

    wrap.appendChild(lab);
    wrap.appendChild(inp);
    grid.appendChild(wrap);
  }

  // load stored labels (if any)
  try {
    const res = await fetch(`/labels/${encodeURIComponent(module.id)}`);
    const data = await res.json();
    if (data.ok && data.labels) {
      if (typeof data.labels.module_name === "string" && data.labels.module_name.trim() !== "") {
        $("modal_module_name").value = data.labels.module_name;
      }
      const ch = data.labels.channels || {};
      for (let i = 1; i <= 16; i++) {
        const v = ch[String(i)];
        if (typeof v === "string") $(`ch_name_${i}`).value = v;
      }
    }
  } catch (e) {
    // ignore
  }

  $("modal_backdrop").style.display = "flex";
}

async function saveModal() {
  const err = $("modal_error");
  if (err) {
    err.style.display = "none";
    err.textContent = "";
  }

  if (!MODAL_CTX.id) return;

  const moduleName = $("modal_module_name").value || "";

  // 1) rename module (backend)
  const r1 = await fetch("/modules/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: MODAL_CTX.id, name: moduleName }),
  });
  const d1 = await r1.json();
  if (!d1.ok) {
    if (err) {
      err.textContent = "Error renaming module: " + d1.error;
      err.style.display = "block";
    }
    return;
  }

  // 2) save labels (module + channels)
  const channels = {};
  for (let i = 1; i <= 16; i++) {
    channels[String(i)] = $(`ch_name_${i}`).value || "";
  }

  const r2 = await fetch("/labels/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      module_id: MODAL_CTX.id,
      module_name: moduleName,
      channels: channels
    }),
  });

  const d2 = await r2.json();
  if (!d2.ok) {
    if (err) {
      err.textContent = "Error saving channel names: " + d2.error;
      err.style.display = "block";
    }
    return;
  }

  closeModal();
  await loadStatus();
  await loadModules();
}

async function removeFromModal() {
  if (!MODAL_CTX.id) return;
  const ok = confirm("Remove this module?");
  if (!ok) return;

  const res = await fetch("/modules/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: MODAL_CTX.id }),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = $("modal_error");
    if (err) {
      err.textContent = "Error removing module: " + data.error;
      err.style.display = "block";
    }
    return;
  }

  closeModal();
  await loadStatus();
  await loadModules();
}

// Expose for onclick in HTML
window.saveModal = saveModal;
window.removeFromModal = removeFromModal;

// --------------------
// Boot
// --------------------
loadStatus();
loadModules();
setInterval(loadStatus, 4000);

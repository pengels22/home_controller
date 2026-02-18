function $(id) { return document.getElementById(id); }

// cache: moduleId -> { type, svgRoot }
const MODULE_SVGS = new Map();

let MODAL_CTX = {
  id: null,
  type: null,
  address: null,
  name: null
};

// ============================================================
// HEAD MODULE (Pi enclosure) — injected FIRST, but NOT part of MODULE_SVGS
// ============================================================

const HEAD_MODULE_SVG = `
<div class="module-card head-card" id="head_module_card">
  <div class="module-header">
    <div>
      <div class="module-title">HEAD MODULE</div>
      <div class="module-sub">PI • STATUS</div>
    </div>
  </div>

  <div class="module-svg" id="head_module_svg">
    <svg id="head_svg" width="170" height="430" viewBox="0 0 170 430" xmlns="http://www.w3.org/2000/svg">
      <!-- NOTE: keep styles minimal / scoped; but HEAD is not included in test logic anyway -->
      <defs>
        <style>
          #head_svg .shadow { fill:#000; opacity:0.18; }
          #head_svg .card { fill:#eeeeee; stroke:#cfcfcf; stroke-width:2; }
          #head_svg .inner { fill:none; stroke:#d7d7d7; stroke-width:2; }
          #head_svg .title { font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:700; fill:#1a1a1a; }
          #head_svg .label { font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; fill:#2a2a2a; }

          #head_svg .ledOuter { fill:#e7e7e7; stroke:#9c9c9c; stroke-width:2; }
          #head_svg .ledPwr { fill:#cfcfcf; stroke:#222; stroke-width:2; }
          #head_svg .ledNet { fill:#cfcfcf; stroke:#222; stroke-width:2; }

          #head_svg .pi { fill:#e5e5e5; stroke:#bdbdbd; stroke-width:2; }
          #head_svg .piWindow { fill:#d9d9d9; stroke:#bdbdbd; stroke-width:2; opacity:0.8; }

          #head_svg .ipBox { fill:#ffffff; stroke:#8a8a8a; stroke-width:2; }
          #head_svg .ipText { font-family:"Courier New",Courier,monospace; font-size:13px; font-weight:700; fill:#000; }
          #head_svg .hat-off { fill:#cfcfcf; }
          #head_svg .hat-a { fill:#ffd43b; }
          #head_svg .hat-b { fill:#ff4d4f; }
          #head_svg .hat-ab { fill:#39d353; }
        </style>
      </defs>

      <rect class="shadow" x="10" y="14" width="150" height="402" rx="16"/>
      <rect class="card" x="8" y="12" width="150" height="402" rx="16"/>

      <text class="title" x="83" y="32" text-anchor="middle">HEAD MODULE</text>

      <!-- power and network LEDs will be rendered inside the Pi enclosure below -->

      <rect class="inner" x="22" y="103" width="122" height="300" rx="12"/>

      <g transform="translate(30,110)">
        <rect class="pi" x="0" y="0" width="106" height="88" rx="10"/>
        <path class="inner" d="M64,0 V12"/>
        <rect class="piWindow" x="18" y="16" width="50" height="28" rx="6"/>
        <rect class="inner" x="22" y="20" width="42" height="20" rx="4"/>

        <!-- moved power/net LEDs inside the Pi enclosure (shifted down by 0.5in -> ~48px) -->
        <text class="label" x="12" y="61">PWR</text>
        <circle class="ledOuter" cx="26" cy="73" r="10"/>
        <circle id="led_pwr" class="ledPwr" cx="26" cy="73" r="6"/>

        <text class="label" x="94" y="61" text-anchor="end">NET</text>
        <circle class="ledOuter" cx="80" cy="73" r="10"/>
        <circle id="led_net" class="ledNet" cx="80" cy="73" r="6"/>
      </g>

      <text class="label" x="34" y="227">IP ADDRESS</text>
      <rect class="ipBox" x="30" y="237" width="110" height="34" rx="8"/>

      <text id="ip_text" class="ipText"
        x="35" y="259"
        textLength="100" lengthAdjust="spacingAndGlyphs">0.0.0.0</text>
      <!-- Hat module indicators (1..8) arranged in 2 columns x 4 rows under the IP box -->
      <g id="hat_indicators" transform="translate(57,305)">
        <text class="label" x="0" y="-8">MODULES</text>
        <!-- left column (1-4) with labels to the left -->
        <text class="label" x="-6" y="8" text-anchor="end">1</text>
        <rect id="hat_mod_1" class="hat-off" x="0" y="0" width="16" height="10" rx="2"><title>Module 1</title></rect>

        <text class="label" x="-6" y="26" text-anchor="end">2</text>
        <rect id="hat_mod_2" class="hat-off" x="0" y="18" width="16" height="10" rx="2"><title>Module 2</title></rect>

        <text class="label" x="-6" y="44" text-anchor="end">3</text>
        <rect id="hat_mod_3" class="hat-off" x="0" y="36" width="16" height="10" rx="2"><title>Module 3</title></rect>

        <text class="label" x="-6" y="62" text-anchor="end">4</text>
        <rect id="hat_mod_4" class="hat-off" x="0" y="54" width="16" height="10" rx="2"><title>Module 4</title></rect>

        <!-- right column (5-8) with labels to the right -->
        <rect id="hat_mod_5" class="hat-off" x="36" y="0" width="16" height="10" rx="2"><title>Module 5</title></rect>
        <text class="label" x="58" y="8" text-anchor="start">5</text>

        <rect id="hat_mod_6" class="hat-off" x="36" y="18" width="16" height="10" rx="2"><title>Module 6</title></rect>
        <text class="label" x="58" y="26" text-anchor="start">6</text>

        <rect id="hat_mod_7" class="hat-off" x="36" y="36" width="16" height="10" rx="2"><title>Module 7</title></rect>
        <text class="label" x="58" y="44" text-anchor="start">7</text>

        <rect id="hat_mod_8" class="hat-off" x="36" y="54" width="16" height="10" rx="2"><title>Module 8</title></rect>
        <text class="label" x="58" y="62" text-anchor="start">8</text>

        <!-- EXT indicator below the two-column grid, same size as module LEDs, label to the left -->
        <text class="label" x="24" y="80" text-anchor="end">EXT</text>
        <rect id="hat_ext" class="hat-off" x="28" y="72" width="16" height="10" rx="2" style="cursor:pointer"><title>EXT</title></rect>
      </g>
      </g>
    </svg>
  </div>
</div>
`;

// Attach the click handler for the external module (global scope)
function attachExtClickHandler() {
  // Called after head SVG is inserted
  const headCard = document.getElementById("head_module_card");
  if (!headCard) return;
  const extRect = headCard.querySelector("#hat_ext");
  if (extRect) {
    extRect.onclick = onExtClick;
    extRect.style.cursor = "pointer";
  }
}

function _insertHeadModule(rowEl) {
  if (!rowEl) return;
  if ($("head_module_card")) return; // already inserted
  rowEl.insertAdjacentHTML("afterbegin", HEAD_MODULE_SVG);
  attachExtClickHandler();
}

function _setHeadLed(svg, sel, on, blink) {
  const el = svg.querySelector(sel);
  if (!el) return;

  if (on) {
    el.style.fill = "#39d353"; // green
    if (blink) el.classList.add("blink");
    else el.classList.remove("blink");
  } else {
    el.style.fill = "#cfcfcf"; // off/gray
    el.classList.remove("blink");
  }
  el.style.opacity = "1";
}

async function _refreshHeadStatusOnce() {
  const card = $("head_module_card");
  if (!card) return;

  const svg = card.querySelector("svg");
  if (!svg) return;

  try {
    const r = await fetch("/api/head_status", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const s = await r.json();

    // Server reachable => power on
    _setHeadLed(svg, "#led_pwr", true, false);

    // Internet OK => blink green
    _setHeadLed(svg, "#led_net", !!s.internet_ok, true);

    // IP
    const ipt = svg.querySelector("#ip_text");
    if (ipt) ipt.textContent = (typeof s.ip === "string" && s.ip) ? s.ip : "0.0.0.0";
    
    // Hat status indicators (modules 1..8)
    try {
      const hr = await fetch('/api/hat_status', { cache: 'no-store' });
      if (hr.ok) {
        const hs = await hr.json();
        if (hs && hs.ok) {
          // prefer explicit modules map if provided
          for (let i = 1; i <= 8; i++) {
            const el = svg.querySelector(`#hat_mod_${i}`);
            if (!el) continue;

            let a = false, b = false;
            if (hs.modules && hs.modules[String(i)]) {
              a = !!hs.modules[String(i)]['24v_a'];
              b = !!hs.modules[String(i)]['24v_b'];
            } else if (hs.ports) {
              const ga = Number(hs.ports.gpio_a || 0);
              const gb = Number(hs.ports.gpio_b || 0);
              a = !!((ga >> (i - 1)) & 1);
              b = !!((gb >> (i - 1)) & 1);
            }

            // color rules: both -> green, only A -> yellow, only B -> red, none -> gray
            if (a && b) el.style.fill = '#39d353';
            else if (a && !b) el.style.fill = '#ffd43b';
            else if (!a && b) el.style.fill = '#ff4d4f';
            else el.style.fill = '#cfcfcf';
          }
        }
      }
    } catch (e) {
      // ignore hat indicator errors
    }
  } catch (e) {
    // API failed
    _setHeadLed(svg, "#led_pwr", false, false);
    _setHeadLed(svg, "#led_net", false, false);
    const ipt = svg.querySelector("#ip_text");
    if (ipt) ipt.textContent = "0.0.0.0";
  }
}

let _HEAD_TIMER = null;
function startHeadStatusPolling() {
  if (_HEAD_TIMER) return;
  _refreshHeadStatusOnce();
  _HEAD_TIMER = setInterval(_refreshHeadStatusOnce, 2000);
}

// ============================================================
// TEST MODE (cycle channels across all non-head modules)
// ============================================================

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

          // EXT indicator (extension board presence)
          try {
            const extEl = svg.querySelector('#hat_ext');
            if (extEl) {
              if (hs.ext_present) extEl.style.fill = '#39d353';
              else extEl.style.fill = '#cfcfcf';
            }
          } catch (e) {
            // ignore
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

window.toggleTest = toggleTest;

// ============================================================
// STATUS PILL
// ============================================================

async function loadStatus() {
  const el = $("status");
  if (!el) return;

  try {
    const res = await fetch("/api/head_status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && data.server_running) {
      el.textContent = `RUNNING`;
      el.classList.remove("status-bad");
      el.classList.add("status-good");
      return;
    }
    throw new Error("no server_running flag");
  } catch (e) {
    el.textContent = "OFFLINE";
    el.classList.remove("status-good");
    el.classList.add("status-bad");
  }
}

// ============================================================
// MODULE LIST + SVG WIRING
// ============================================================

async function loadModules() {
  const row = $("modules");
  if (!row) return;

  const res = await fetch("/modules");
  const data = await res.json();
// Attach the click handler for the external module (global scope)
function attachExtClickHandler() {
  // Called after head SVG is inserted
  const headCard = document.getElementById("head_module_card");
  if (!headCard) return;
  const extRect = headCard.querySelector("#hat_ext");
  if (extRect) {
    extRect.onclick = onExtClick;
    extRect.style.cursor = "pointer";
  }
}

  row.innerHTML = "";
  MODULE_SVGS.clear(); // prevent stale svg references

  // Always show head module first
  _insertHeadModule(row);
  startHeadStatusPolling();

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

    try {
      const svgRes = await fetch(`/modules/svg/${m.type}`);
      if (!svgRes.ok) throw new Error("SVG not found");
      const svgText = await svgRes.text();
      svgHolder.innerHTML = svgText;

      const svgRoot = svgHolder.querySelector("svg");
      if (svgRoot) {
        // IMPORTANT: only real modules go in MODULE_SVGS; head never does.
        MODULE_SVGS.set(m.id, { type: String(m.type).toLowerCase(), svgRoot });
      }
    } catch (e) {
      svgHolder.textContent = `No SVG for type: ${m.type}`;
      MODULE_SVGS.delete(m.id);
    }
  }
}

// ============================================================
// ADD PAGE SUPPORT
// ============================================================

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

window.addModuleThenGoBack = addModuleThenGoBack;

// ============================================================
// MODAL (SETTINGS)
// ============================================================

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
  $("modal_address_display").textContent = module.address || "0x00";

  // setup change address button and prompt
  const changeBtn = $("change_addr_btn");
  const addrPrompt = $("addr_prompt");
  const addrInput = $("addr_prompt_input");
  const addrCancel = $("addr_prompt_cancel");
  const addrOk = $("addr_prompt_ok");
  const addrErr = $("addr_prompt_error");

  if (changeBtn) {
    changeBtn.onclick = () => {
      if (addrErr) { addrErr.style.display = 'none'; addrErr.textContent = ''; }
      addrInput.value = module.address || '';
      addrPrompt.style.display = 'block';
      addrInput.focus();
    };
  }
  if (addrCancel) addrCancel.onclick = () => { addrPrompt.style.display = 'none'; if (addrErr) { addrErr.style.display='none'; addrErr.textContent=''; } };
  if (addrOk) addrOk.onclick = async () => {
    const newAddr = addrInput.value.trim();
    if (!newAddr) {
      if (addrErr) { addrErr.textContent = 'Address required'; addrErr.style.display = 'block'; }
      return;
    }
    // call change address
    try {
      const res = await fetch('/modules/change_address', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: MODAL_CTX.id, address: newAddr }) });
      const j = await res.json();
      if (!j.ok) {
        if (addrErr) { addrErr.textContent = j.error || 'change failed'; addrErr.style.display = 'block'; }
        return;
      }
      // success: update modal and UI
      MODAL_CTX.id = j.module.id || MODAL_CTX.id;
      MODAL_CTX.address = j.module.address || MODAL_CTX.address;
      $("modal_address_display").textContent = MODAL_CTX.address;
      $("modal_sub").textContent = `${MODAL_CTX.address} • ${MODAL_CTX.id}`;
      addrPrompt.style.display = 'none';
      await loadModules();
    } catch (e) {
      if (addrErr) { addrErr.textContent = String(e); addrErr.style.display = 'block'; }
    }
  };

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

window.saveModal = saveModal;
window.removeFromModal = removeFromModal;

// ============================================================
// BOOT
// ============================================================


// --- SVG SWAP LOGIC FOR EXT/EXPANDER ---
let _originalHeadModuleHTML = null;
let _expanderSVGCache = null;


async function onExtClick(event) {
  event?.stopPropagation?.();
  const headCard = document.getElementById("head_module_card");
  if (!headCard) return;
  if (!_originalHeadModuleHTML) {
    _originalHeadModuleHTML = headCard.innerHTML;
  }
  // Fetch and inject expander SVG
  if (!_expanderSVGCache) {
    try {
      const res = await fetch("/modules/svg/i2c");
      if (!res.ok) throw new Error("Failed to load expander SVG");
      _expanderSVGCache = await res.text();
    } catch (e) {
      alert("Could not load expander SVG: " + e);
      return;
    }
  }
  // Updated HTML structure for expander SVG
  // Replace the module card in its parent container
  headCard.innerHTML = `
    <div class="module-header">
      <div>
        <div class="module-title">I2C EXPANDER</div>
      </div>
    </div>
    <div class="module-svg" id="expander_module_svg">
      ${_expanderSVGCache}
    </div>
  `;
  // Attach back button handler after SVG is in DOM
  setTimeout(() => {
    const backBtn = document.getElementById("head_module_card").querySelector("#expander_back_btn");
    if (backBtn) {
      backBtn.onclick = onExpanderBackClick;
    }
  }, 0);
}

window.onExtClick = onExtClick;

function onExpanderBackClick(event) {
  event?.stopPropagation?.();
  const headCard = document.getElementById("head_module_card");
  if (!headCard || !_originalHeadModuleHTML) return;
  headCard.innerHTML = _originalHeadModuleHTML;
  attachExtClickHandler();
}

window.onExpanderBackClick = onExpanderBackClick;

// --- END SVG SWAP LOGIC ---

loadStatus();
loadModules();
setInterval(loadStatus, 4000);

// ------------------ Unified IO Channel Popup Modal ------------------
// DOM helper for getElementById (used throughout)
function $(id) { return document.getElementById(id); }
// Ensures a single overlay for popup dismissal
function ensureIoChannelPopupOverlay() {
  let overlay = document.querySelector('.io-channel-popup-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'io-channel-popup-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.01)';
    overlay.style.zIndex = '10000';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
    overlay.onclick = (e) => {
      // Only close if click is directly on overlay, not popup
      if (e.target === overlay) hideIoChannelPopup();
    };
  }
  return overlay;
}

// Ensures a single popup DOM node
function ensureIoChannelPopup() {
  document.querySelectorAll('.io-channel-popup').forEach((el, i) => { if (i > 0) el.remove(); });
  let popup = document.querySelector('.io-channel-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.className = 'io-channel-popup';
    popup.innerHTML = `
      <div class="popup-title"></div>
      <div class="popup-status"></div>
      <div class="popup-controls"></div>
    `;
    document.body.appendChild(popup);
  }
  return popup;
}

/**
 * Show IO Channel Popup with controls for DI/DO/AIO
 * @param {object|string} name - Channel name or context object
 * @param {string} [status] - Channel status (if name is string)
 */
function showIoChannelPopup(name, status) {
  const popup = ensureIoChannelPopup();
  const overlay = ensureIoChannelPopupOverlay();
  let ctx = typeof name === 'object' ? name : { name, status };
  // If this is a per-channel popup (has channel property), show minimal info
  if (ctx.channel) {
    popup.querySelector('.popup-title').textContent = ctx.name || `Channel ${ctx.channel}`;
    popup.querySelector('.popup-status').textContent = ctx.status ? `Status: ${ctx.status}` : '';
    const controls = popup.querySelector('.popup-controls');
    // For AIO, distinguish between AI and AO by channel number (1-8 = AI, 9-16 = AO)
    if (ctx.type === 'aio') {
      let isAI = ctx.channel >= 1 && ctx.channel <= 8;
      let isAO = ctx.channel >= 9 && ctx.channel <= 16;
      let chNum = ctx.channel;
      let html = '';
      // Current voltage value, fallback to blank if not provided
      let currentVoltage = (ctx.current_voltage !== undefined && ctx.current_voltage !== null) ? ctx.current_voltage : '';
      if (isAI) {
        html = `
          <div style=\"display:flex;flex-direction:column;gap:8px;align-items:flex-start;min-width:220px\">
            <div><b>Name:</b> <span id=\"aio_ch_name\">${ctx.name || `AI${chNum}`}</span></div>
            <div><b>Max Voltage:</b> <span id=\"aio_ch_maxv\">${ctx.max_voltage !== undefined ? ctx.max_voltage : ''}</span> V</div>
            <div><b>Current Voltage:</b> <span id=\"aio_ch_curv\">${currentVoltage}</span> V</div>
          </div>
        `;
      } else if (isAO) {
        html = `
          <div style=\"display:flex;flex-direction:column;gap:8px;align-items:flex-start;min-width:220px\">
            <div><b>Name:</b> <span id=\"aio_ch_name\">${ctx.name || `AO${chNum-8}`}</span></div>
            <div><b>Max Voltage:</b> <span id=\"aio_ch_maxv\">${ctx.max_voltage !== undefined ? ctx.max_voltage : ''}</span> V</div>
            <div><b>Current Voltage:</b> <span id=\"aio_ch_curv\">${currentVoltage}</span> V</div>
            <div><b>Set Voltage:</b> <input id=\"aio_set_voltage\" type=\"number\" min=\"0\" max=\"24\" step=\"0.5\" style=\"width:80px\" /> V</div>
            <button id=\"aio_drive_btn\">Drive</button>
          </div>
        `;
      } else {
        html = `<div>Unknown channel</div>`;
      }
      controls.innerHTML = html;
      // Optionally: wire up drive button for AO
      if (isAO) {
        controls.querySelector('#aio_drive_btn').onclick = function() {
          const v = parseFloat(controls.querySelector('#aio_set_voltage').value);
          if (isNaN(v) || v < 0 || v > 24) {
            alert('Enter a voltage between 0 and 24V');
            return;
          }
          // TODO: send to backend to drive AO
          alert(`Would drive AO${chNum-8} to ${v}V (implement backend)`);
        };
      }
    } else if (ctx.type === 'di' || ctx.type === 'do') {
      // For DI/DO: show name, status, override, and logic invert
      controls.innerHTML = `
        <div style=\"display:flex;flex-direction:column;gap:10px;align-items:flex-start;min-width:220px\">
          <div><b>Name:</b> <span>${ctx.name || `Channel ${ctx.channel}`}</span></div>
          <div><b>Status:</b> <span>${ctx.status || ''}</span></div>
          <div><b>Override:</b>
            <select id=\"ch_override\">
              <option value=\"none\">None</option>
              <option value=\"on\">On</option>
              <option value=\"off\">Off</option>
            </select>
          </div>
          <div><label><input type=\"checkbox\" id=\"ch_invert\" /> Logic Invert</label></div>
        </div>
      `;
      // Per-channel: auto-save on overlay click
      if (overlay) {
        overlay.onclick = async function(e) {
          if (e.target === overlay) {
            await saveChannelOnClose();
            hideIoChannelPopup();
          }
        };
      }
      // Fetch current invert/override state for this channel (always latest)
      async function fetchAndSetChannelState() {
        if (ctx.module_id && ctx.channel) {
          const r = await fetch(`/api/module_config_get?module_id=${encodeURIComponent(ctx.module_id)}`);
          const data = await r.json();
          if (data.ok) {
            let inv = data.invert && data.invert[String(ctx.channel)];
            if (typeof inv === 'string') inv = inv === 'true';
            const ov = data.override && data.override[String(ctx.channel)];
            controls.querySelector('#ch_invert').checked = !!inv;
            if (typeof ov === 'string') controls.querySelector('#ch_override').value = ov;
          }
        }
      }
      fetchAndSetChannelState();
      // Auto-save on close (Close button or overlay)
      async function saveChannelOnClose() {
        const override = controls.querySelector('#ch_override').value;
        const invert = controls.querySelector('#ch_invert').checked;
        if (!ctx.module_id) return;
        await fetch('/api/module_config_set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            module_id: ctx.module_id,
            channel: ctx.channel,
            override: override,
            invert: invert
          })
        });
        window._lastModuleConfigPopupReload = Date.now();
        if (typeof loadModules === 'function') loadModules();
      }
      // Patch overlay for per-channel popup
      if (overlay) {
        const origOverlay = overlay.onclick;
        overlay.onclick = async function(e) {
          if (e.target === overlay) {
            await saveChannelOnClose();
            hideIoChannelPopup();
            if (typeof origOverlay === 'function') origOverlay(e);
          }
        };
      }
    } else {
      // For other types: just show name and status
      controls.innerHTML = `
        <div style=\"display:flex;flex-direction:column;gap:8px;align-items:flex-start;min-width:220px\">
          <div><b>Name:</b> <span>${ctx.name || `Channel ${ctx.channel}`}</span></div>
          <div><b>Status:</b> <span>${ctx.status || ''}</span></div>
        </div>
      `;
    }
    // Remove all close buttons first
    popup.querySelectorAll('.popup-close').forEach(btn => btn.remove());
    // Add per-channel close button (bottom center)
    const channelCloseBtn = document.createElement('button');
    channelCloseBtn.className = 'popup-close channel';
    channelCloseBtn.textContent = 'Close';
    channelCloseBtn.title = 'Close';
    channelCloseBtn.onclick = async () => {
      await saveChannelOnClose();
      hideIoChannelPopup();
    };
    popup.appendChild(channelCloseBtn);
    popup.classList.add('active');
    overlay.style.display = 'block';
    document.body.classList.add('modal-open');
    return;
  }
  // Otherwise, show full settings popup (gear/settings button)
  // Always ensure ctx has module_id, type, etc. If missing, try to find from modules list
  if (!ctx.module_id || !ctx.type) {
    // Try to find module by name or fallback to first DI/DO module
    if (window.MODULE_SVGS && window.MODULE_SVGS.size > 0) {
      for (const [modId, modInfo] of window.MODULE_SVGS.entries()) {
        if (!ctx.type || modInfo.type === ctx.type) {
          ctx.module_id = modId;
          ctx.type = modInfo.type;
          break;
        }
      }
    }
  }
  popup.querySelector('.popup-title').textContent = ctx.name || name;
  popup.querySelector('.popup-status').textContent = `Status: ${ctx.status || status}`;
  const controls = popup.querySelector('.popup-controls');
  controls.innerHTML = '<div>Loading…</div>';
  // Remove all close buttons first
  popup.querySelectorAll('.popup-close').forEach(btn => btn.remove());
  // Add close button for global popup if not present
  if (!popup.querySelector('.popup-close.global')) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close global';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = async () => {
      if (typeof saveAndClose === 'function') {
        await saveAndClose();
      } else {
        hideIoChannelPopup();
      }
    };
    popup.appendChild(closeBtn);
  }
  let url = '';
  if (ctx.type === 'di') url = '/di_config_popup';
  else if (ctx.type === 'do') url = '/do_config_popup';
  else if (ctx.type === 'aio') url = '/aio_config_popup';
  else if (ctx.type === 'ext') url = '/ext_config_popup';
  if (url && ctx.module_id) {
    fetch(url)
      .then(r => r.text())
      .then(async html => {
        controls.innerHTML = html;
        // If DI/DO, fetch per-channel invert/override state from backend and update form
        if (ctx.type === 'di' || ctx.type === 'do') {
          try {
            const res = await fetch(`/api/module_config_get?module_id=${encodeURIComponent(ctx.module_id)}`);
            const data = await res.json();
            if (data.ok) {
              // For each channel 1-16, update override/invert controls
              for (let i = 1; i <= 16; i++) {
                // Override
                const ov = data.override && data.override[String(i)];
                const ovSel = controls.querySelector(`[name='ch${i}_override']`);
                if (ovSel && typeof ov === 'string') ovSel.value = ov;
                // Invert (handle boolean or string 'true'/'false')
                let inv = data.invert && data.invert[String(i)];
                if (typeof inv === 'string') {
                  inv = inv === 'true';
                }
                const invChk = controls.querySelector(`[name='ch${i}_invert']`);
                if (invChk) invChk.checked = !!inv;
              }
            }
          } catch (e) {
            // ignore errors, fallback to defaults
          }
          // Save handler for the global popup form: only bottom center Close button saves and closes
          const form = controls.querySelector('form');
          if (form) {
            // Remove any submit button
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.remove();
            // Save on close (bottom center Close button only)
            const closeBtn = form.parentElement.querySelector('button.global-close-btn');
            async function saveAndClose() {
              if (!ctx.module_id) return;
              const override = {};
              const invert = {};
              for (let i = 1; i <= 16; i++) {
                const ovSel = form.querySelector(`[name='ch${i}_override']`);
                const invChk = form.querySelector(`[name='ch${i}_invert']`);
                if (ovSel) override[i] = ovSel.value;
                if (invChk) invert[i] = !!invChk.checked;
              }
              await fetch('/api/module_config_set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  module_id: ctx.module_id,
                  override: override,
                  invert: invert
                })
              });
              hideIoChannelPopup();
              window._lastModuleConfigPopupReload = Date.now();
              if (typeof loadModules === 'function') loadModules();
            }
            if (closeBtn) {
              closeBtn.onclick = saveAndClose;
            }
          }
        }
      });
  } else {
    controls.innerHTML = '<div>No config popup for this module type or module_id missing.</div>';
  }
  popup.classList.add('active');
  overlay.style.display = 'block';
  document.body.classList.add('modal-open');
}

function hideIoChannelPopup() {
  const popup = document.querySelector('.io-channel-popup');
  const overlay = document.querySelector('.io-channel-popup-overlay');
  if (popup) {
    popup.classList.remove('active');
    // Remove all close buttons
    popup.querySelectorAll('.popup-close').forEach(btn => btn.remove());
    // Optionally clear controls
    popup.querySelector('.popup-controls').innerHTML = '';
    popup.querySelector('.popup-title').textContent = '';
    popup.querySelector('.popup-status').textContent = '';
  }
  if (overlay) overlay.style.display = 'none';
  document.body.classList.remove('modal-open');
}
window.showIoChannelPopup = showIoChannelPopup;
window.hideIoChannelPopup = hideIoChannelPopup;

// cache: moduleId -> { type, svgRoot }
const MODULE_SVGS = new Map();

let MODAL_CTX = {
  id: null,
  type: null,
  address: null,
  name: null
};

// Some browsers hide freshly injected inline SVGs unless we nudge display/visibility.
// Keep this lightweight so a missing helper never blocks rendering.
function ensureSvgVisible(svgRoot) {
  if (!svgRoot) return;
  if (!svgRoot.style.display) svgRoot.style.display = "block";
  svgRoot.style.visibility = "visible";
  // Remove any forced opacity to avoid accidental transparency
  svgRoot.style.opacity = "1";
  svgRoot.style.filter = "none";
}

// Scope inline <style> rules inside an injected SVG so they don't leak to other SVGs.
function scopeSvgStyles(svgRoot, scopeClass) {
  if (!svgRoot || !scopeClass) return;
  svgRoot.classList.add(scopeClass);

  const styles = svgRoot.querySelectorAll("style");
  styles.forEach((st) => {
    const css = st.textContent || "";
    if (!css) return;

    // Simple selector-body parser that won't split on commas inside declarations
    const out = [];
    const regex = /([^{}]+){([^{}]*)}/g;
    let m;
    while ((m = regex.exec(css)) !== null) {
      const sel = m[1].trim();
      const body = m[2];
      if (!sel || sel.startsWith("@")) {
        out.push(`${sel}{${body}}`);
        continue;
      }
      // prefix each selector in the group
      const scopedSel = sel
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `.${scopeClass} ${s}`)
        .join(", ");
      out.push(`${scopedSel}{${body}}`);
    }
    if (out.length) st.textContent = out.join(" ");
  });
}

// ============================================================
// “DIM/OVERLAY” DEFENSE (THIS IS THE REAL FIX)
// ============================================================

function _clearAnyDimState() {
  // Hide modal backdrop if it exists
  const b = $("modal_backdrop");
  if (b) {
    b.style.display = "none";
    b.style.pointerEvents = "none";
  }

  // Remove any body classes that typically cause dim/blur
  document.body.classList.remove("modal-open", "dim", "busy", "disabled");

  // Only pointer events and display are managed now
  const reset = (el) => {
    if (!el) return;
    el.style.pointerEvents = "";
  };

  reset(document.body);
  reset(document.querySelector(".container"));

  document.querySelectorAll(".card, .modules-row, #modules, .module-card, .module-card svg, .module-svg")
    .forEach(reset);

  // If any “overlay-ish” nodes exist, force them off
  document.querySelectorAll(".modal-backdrop, .overlay, .backdrop")
    .forEach(el => {
      el.style.display = "none";
      el.style.pointerEvents = "none";
    });
}

// Ensures SVG isn’t inheriting odd filter/opacity from Safari quirks


// ============================================================
// HEAD MODULE (Pi enclosure) — injected FIRST, NOT in MODULE_SVGS
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
      <defs>
        <style>
          #head_svg .shadow { fill:#000; }
          #head_svg .card { fill:#eeeeee; stroke:#cfcfcf; stroke-width:2; }
          #head_svg .inner { fill:none; stroke:#d7d7d7; stroke-width:2; }
          #head_svg .title { font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:700; fill:#1a1a1a; }
          #head_svg .label { font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; fill:#2a2a2a; }

          #head_svg .ledOuter { fill:#e7e7e7; stroke:#9c9c9c; stroke-width:2; }
          #head_svg .ledPwr { fill:#cfcfcf; stroke:#222; stroke-width:2; }
          #head_svg .ledNet { fill:#cfcfcf; stroke:#222; stroke-width:2; }

          #head_svg .pi { fill:#e5e5e5; stroke:#bdbdbd; stroke-width:2; }
          #head_svg .piWindow { fill:#d9d9d9; stroke:#bdbdbd; stroke-width:2; }

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

      <rect class="inner" x="22" y="103" width="122" height="300" rx="12"/>

      <g transform="translate(30,110)">
        <rect class="pi" x="0" y="0" width="106" height="88" rx="10"/>
        <path class="inner" d="M64,0 V12"/>
        <rect class="piWindow" x="18" y="16" width="50" height="28" rx="6"/>
        <rect class="inner" x="22" y="20" width="42" height="20" rx="4"/>

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

      <g id="hat_indicators" transform="translate(57,305)">
        <text class="label" x="0" y="-8">MODULES</text>

        <text class="label" x="-6" y="8" text-anchor="end">1</text>
        <rect id="hat_mod_1" class="hat-off" x="0" y="0" width="16" height="10" rx="2"><title>Module 1</title></rect>

        <text class="label" x="-6" y="26" text-anchor="end">2</text>
        <rect id="hat_mod_2" class="hat-off" x="0" y="18" width="16" height="10" rx="2"><title>Module 2</title></rect>

        <text class="label" x="-6" y="44" text-anchor="end">3</text>
        <rect id="hat_mod_3" class="hat-off" x="0" y="36" width="16" height="10" rx="2"><title>Module 3</title></rect>

        <text class="label" x="-6" y="62" text-anchor="end">4</text>
        <rect id="hat_mod_4" class="hat-off" x="0" y="54" width="16" height="10" rx="2"><title>Module 4</title></rect>

        <rect id="hat_mod_5" class="hat-off" x="36" y="0" width="16" height="10" rx="2"><title>Module 5</title></rect>
        <text class="label" x="58" y="8" text-anchor="start">5</text>

        <rect id="hat_mod_6" class="hat-off" x="36" y="18" width="16" height="10" rx="2"><title>Module 6</title></rect>
        <text class="label" x="58" y="26" text-anchor="start">6</text>

        <rect id="hat_mod_7" class="hat-off" x="36" y="36" width="16" height="10" rx="2"><title>Module 7</title></rect>
        <text class="label" x="58" y="44" text-anchor="start">7</text>

        <rect id="hat_mod_8" class="hat-off" x="36" y="54" width="16" height="10" rx="2"><title>Module 8</title></rect>
        <text class="label" x="58" y="62" text-anchor="start">8</text>

        <text class="label" x="-6" y="80" text-anchor="end">EXT</text>
        <rect id="hat_ext" class="hat-off" x="0" y="72" width="16" height="10" rx="2" style="cursor:pointer"><title>EXT</title></rect>

        <rect id="hat_ext_2" class="hat-off" x="36" y="72" width="16" height="10" rx="2" style="cursor:pointer"><title>EXT</title></rect>
        <text class="label" x="58" y="80" text-anchor="start">EXT</text>
      </g>
    </svg>
  </div>
</div>
`;

// EXT click hookup
function attachExtClickHandler() {
  // Remove EXT indicator click handler
  const headCard = document.getElementById("head_module_card");
  if (!headCard) return;
  const extRect = headCard.querySelector("#hat_ext");
  if (extRect) {
    extRect.onclick = null;
    extRect.style.cursor = "default";
  }
  const extRect2 = headCard.querySelector("#hat_ext_2");
  if (extRect2) {
    extRect2.onclick = null;
    extRect2.style.cursor = "default";
  }
}

function _insertHeadModule(rowEl) {
  if (!rowEl) return;
  if ($("head_module_card")) return;
  rowEl.insertAdjacentHTML("afterbegin", HEAD_MODULE_SVG);
  attachExtClickHandler();
}

// ============================================================
// HEAD STATUS
// ============================================================

function _setHeadLed(svg, sel, on, blink) {
  const el = svg.querySelector(sel);
  if (!el) return;

  if (on) {
    el.style.fill = "#39d353";
    if (blink) el.classList.add("blink");
    else el.classList.remove("blink");
  } else {
    el.style.fill = "#cfcfcf";
    el.classList.remove("blink");
  }
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

    _setHeadLed(svg, "#led_pwr", true, false);
    _setHeadLed(svg, "#led_net", !!s.internet_ok, true);

    const ipt = svg.querySelector("#ip_text");
    if (ipt) ipt.textContent = (typeof s.ip === "string" && s.ip) ? s.ip : "0.0.0.0";

    // Hat indicators
    try {
      const hr = await fetch("/api/hat_status", { cache: "no-store" });
      if (hr.ok) {
        const hs = await hr.json();
        if (hs && hs.ok) {
          for (let i = 1; i <= 8; i++) {
            const el = svg.querySelector(`#hat_mod_${i}`);
            if (!el) continue;

            let a = false, b = false;
            if (hs.modules && hs.modules[String(i)]) {
              a = !!hs.modules[String(i)]["24v_a"];
              b = !!hs.modules[String(i)]["24v_b"];
            } else if (hs.ports) {
              const ga = Number(hs.ports.gpio_a || 0);
              const gb = Number(hs.ports.gpio_b || 0);
              a = !!((ga >> (i - 1)) & 1);
              b = !!((gb >> (i - 1)) & 1);
            }

          if (a && b) el.style.fill = "#39d353";
          else if (a && !b) el.style.fill = "#ffd43b";
          else if (!a && b) el.style.fill = "#ff4d4f";
          else el.style.fill = "#cfcfcf";
        }

          const extEl = svg.querySelector("#hat_ext");
          const extEl2 = svg.querySelector("#hat_ext_2");
          const extFill = hs.ext_present ? "#39d353" : "#cfcfcf";
          if (extEl) extEl.style.fill = extFill;
          if (extEl2) extEl2.style.fill = extFill;
        }
      }
    } catch (e) {
      // ignore hat indicator errors
    }
  } catch (e) {
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

    // Only toggle led-on/led-off on circles, not numbers
    const circles = root.querySelectorAll("g[id^='ch'] circle.led, g[id^='ch'] circle.led-on, g[id^='ch'] circle.led-off");
    circles.forEach((el) => {
      el.classList.remove("led-on");
      el.classList.add("led-off");
    });
  }
}

function _findLedElement(moduleType, svgRoot, channelIndex) {
  if (!svgRoot) return null;
  const mt = String(moduleType || "").toLowerCase();

  const id2 = `ch${String(channelIndex).padStart(2, "0")}`;
  let el = svgRoot.querySelector(`#${id2}`);
  if (el) return el;

  const id1 = `ch${channelIndex}`;
  el = svgRoot.querySelector(`#${id1}`);
  if (el) return el;

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
  // Only toggle led-on/led-off on circles, not numbers
  if (el.tagName && el.tagName.toLowerCase() === 'circle') {
    if (on) {
      el.classList.add("led-on");
      el.classList.remove("led-off");
    } else {
      el.classList.remove("led-on");
      el.classList.add("led-off");
    }
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
      el.textContent = "RUNNING";
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
  _clearAnyDimState();

  const row = $("modules");
  if (!row) return;

  const res = await fetch("/modules");
  const data = await res.json();

  row.innerHTML = "";
  MODULE_SVGS.clear();

  // Insert head module row
  _insertHeadModule(row);
  startHeadStatusPolling();

  if (!data || data.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No modules configured yet.";
    row.appendChild(empty);
    return;
  }

  // Partition modules: ext and its subsystem, others
  const extModules = [];
  const extSubsystem = [];
  const normalModules = [];
  let extSubsystemType = null;

  for (const m of data) {
    if (String(m.type).toLowerCase() === "ext") {
      extModules.push(m);
      extSubsystemType = m.subsystem || null;
    }
  }
  for (const m of data) {
    if (String(m.type).toLowerCase() !== "ext" && extSubsystemType && m.subsystem === extSubsystemType) {
      extSubsystem.push(m);
    } else if (String(m.type).toLowerCase() !== "head" && String(m.type).toLowerCase() !== "ext") {
      normalModules.push(m);
    }
  }

  // Render all modules in one row (avoid Safari dimming when stacking rows)
  const orderedModules = normalModules.concat(extModules).concat(extSubsystem);

  for (const m of orderedModules) {
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
    // Always pass correct context for global popup
    gear.onclick = () => showIoChannelPopup({
      module_id: m.id,
      type: m.type && m.type.toLowerCase(),
      name: m.name || `${String(m.type || '').toUpperCase()} MODULE`,
      address: m.address,
      status: m.status || undefined
    });

    header.appendChild(left);
    header.appendChild(gear);

    const svgHolder = document.createElement("div");
    svgHolder.className = "module-svg";
    svgHolder.textContent = "Loading…";

    card.appendChild(header);
    card.appendChild(svgHolder);
    row.appendChild(card);

    try {
      // Use i2c expander SVG for ext modules (fixes SVG path)
      const svgType = String(m.type || "").toLowerCase();
      // If module type is 'ext', fetch 'i2c' SVG, else use module type
      const fetchType = svgType === "ext" ? "i2c" : svgType;
      const svgRes = await fetch(`/modules/svg/${fetchType}`);
      if (!svgRes.ok) throw new Error("SVG not found");
      const svgText = await svgRes.text();
      svgHolder.innerHTML = svgText;

      const svgRoot = svgHolder.querySelector("svg");
      if (svgRoot) {
        const scopeClass = `svgscope-${m.id || fetchType || Math.random().toString(36).slice(2, 8)}`;
        scopeSvgStyles(svgRoot, scopeClass);
        ensureSvgVisible(svgRoot);
        MODULE_SVGS.set(m.id, { type: String(m.type).toLowerCase(), svgRoot });

        // Add onclick to IO bubbles (circles) for popup
        if (["di", "do", "aio"].includes(String(m.type).toLowerCase())) {
          const channelGroups = svgRoot.querySelectorAll("g[id^='ch']");
          channelGroups.forEach((g, idx) => {
            const circle = g.querySelector("circle.led");
            if (circle) {
              circle.style.cursor = "pointer";
              circle.onclick = (e) => {
                e.stopPropagation();
                const chNum = idx + 1;
                // Try to get custom channel name from labels if available
                let chName = `Channel ${chNum}`;
                if (m.labels && m.labels.channels && m.labels.channels[String(chNum)]) {
                  chName = m.labels.channels[String(chNum)];
                }
                const status = circle.classList.contains("led-on") ? "ON" : "OFF";
                // Pass type and channel for popup controls
                showIoChannelPopup({
                  name: chName,
                  status,
                  type: m.type.toLowerCase(),
                  channel: chNum,
                  module_id: m.id
                });
              };
            }
          });
        }
      }
    } catch (e) {
      svgHolder.textContent = `No SVG for type: ${m.type}`;
      MODULE_SVGS.delete(m.id);
    }
  }

  // (Ext row removed: all modules rendered together)

  _clearAnyDimState();

  // NOTE: opacity/filters are now handled directly in CSS and ensureSvgVisible
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
  if (b) b.style.display = "none";

  const err = $("modal_error");
  if (err) {
    err.style.display = "none";
    err.textContent = "";
  }

  document.body.classList.remove("modal-open");
  MODAL_CTX = { id: null, type: null, address: null, name: null };

  _clearAnyDimState();
}
window.closeModal = closeModal;

async function openModal(module) {
  _clearAnyDimState();

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

  const changeBtn = $("change_addr_btn");
  const addrPrompt = $("addr_prompt");
  const addrInput = $("addr_prompt_input");
  const addrCancel = $("addr_prompt_cancel");
  const addrOk = $("addr_prompt_ok");
  const addrErr = $("addr_prompt_error");

  if (changeBtn) {
    changeBtn.onclick = () => {
      if (addrErr) { addrErr.style.display = "none"; addrErr.textContent = ""; }
      addrInput.value = module.address || "";
      addrPrompt.style.display = "block";
      addrInput.focus();
    };
  }

  if (addrCancel) addrCancel.onclick = () => {
    addrPrompt.style.display = "none";
    if (addrErr) { addrErr.style.display = "none"; addrErr.textContent = ""; }
  };

  if (addrOk) addrOk.onclick = async () => {
    const newAddr = addrInput.value.trim();
    if (!newAddr) {
      if (addrErr) { addrErr.textContent = "Address required"; addrErr.style.display = "block"; }
      return;
    }
    try {
      const res = await fetch("/modules/change_address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: MODAL_CTX.id, address: newAddr })
      });
      const j = await res.json();
      if (!j.ok) {
        if (addrErr) { addrErr.textContent = j.error || "change failed"; addrErr.style.display = "block"; }
        return;
      }
      MODAL_CTX.id = j.module.id || MODAL_CTX.id;
      MODAL_CTX.address = j.module.address || MODAL_CTX.address;
      $("modal_address_display").textContent = MODAL_CTX.address;
      $("modal_sub").textContent = `${MODAL_CTX.address} • ${MODAL_CTX.id}`;
      addrPrompt.style.display = "none";
      await loadModules();
    } catch (e) {
      if (addrErr) { addrErr.textContent = String(e); addrErr.style.display = "block"; }
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

  const backdrop = $("modal_backdrop");
  if (backdrop) {
    backdrop.style.display = "flex";
    backdrop.style.pointerEvents = "auto";
  }
  document.body.classList.add("modal-open");
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
// EXT / EXPANDER SWAP LOGIC
// ============================================================

let _originalHeadModuleHTML = null;
let _expanderSVGCache = null;

async function onExtClick(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();

  // THIS is what stops the “gray overlay” from sticking
  closeModal();
  _clearAnyDimState();

  const headCard = document.getElementById("head_module_card");
  if (!headCard) return;

  if (!_originalHeadModuleHTML) {
    _originalHeadModuleHTML = headCard.innerHTML;
  }

  if (!_expanderSVGCache) {
    try {
      // Fetch the correct expander SVG file (server route name is 'i2c')
      const res = await fetch("/modules/svg/i2c");
      if (!res.ok) throw new Error("Failed to load expander SVG");
      _expanderSVGCache = await res.text();
    } catch (e) {
      alert("Could not load expander SVG: " + e);
      return;
    }
  }

  headCard.className = "module-card head-card";
  headCard.innerHTML = `
    <div class="module-header">
      <div>
        <div class="module-title">I2C EXPANDER</div>
      </div>
      <button class="icon-btn" id="expander_settings_btn" title="Settings">⚙️</button>
    </div>
    <div class="module-svg" id="expander_module_svg"></div>
  `;

  const svgContainer = headCard.querySelector("#expander_module_svg");
  if (svgContainer) {
    svgContainer.classList.add("module-svg");
    svgContainer.innerHTML = _expanderSVGCache;

    const svgRoot = svgContainer.querySelector("svg");
    if (svgRoot) {
      scopeSvgStyles(svgRoot, "svgscope-expander");
      ensureSvgVisible(svgRoot);
    }
  }

    setTimeout(() => {
      _clearAnyDimState();

      const backBtn = document.getElementById("head_module_card")?.querySelector("#expander_back_btn");
      if (backBtn) backBtn.onclick = onExpanderBackClick;

      const settingsBtn = document.getElementById("expander_settings_btn");
      if (settingsBtn) {
        settingsBtn.onclick = showExpanderSettingsPopup;
      }
    }, 0);
}

// Expansion Card Settings Popup (Expander/Extender)
async function showExpanderSettingsPopup() {
  const popup = ensureIoChannelPopup();
  const overlay = ensureIoChannelPopupOverlay();
  popup.querySelector('.popup-title').textContent = "Expansion Card Settings";
  popup.querySelector('.popup-status').textContent = "";
  const controls = popup.querySelector('.popup-controls');
  controls.innerHTML = "Loading…";

  // Fetch config
  const res = await fetch("/api/expansion_config");
  const data = await res.json();
  if (!data.ok) { controls.innerHTML = "Failed to load config"; return; }
  const exp = data.exp;

  // Build form with 2px padding for all inputs
  let html = `
    <form id="expander_settings_form">
      <div style="margin-bottom:10px;">
        <label style="padding:2px;">Name</label><br/>
        <input style="padding:2px;" name="name" value="${exp.name || ""}" />
      </div>
      <div style="margin-bottom:10px;">
        <label style="padding:2px;">I2C Address</label><br/>
        <input style="padding:2px;" name="address_hex" value="${exp.address_hex || ""}" />
      </div>
      <hr/>
      <h3>Channels</h3>
  `;
  exp.channels.forEach((ch, i) => {
    html += `
      <div style="margin-bottom:10px;">
        <label style="padding:2px;">Channel ${i+1} Name</label><br/>
        <input style="padding:2px;" name="ch${i}_name" value="${ch.name || ""}" />
        <label style="padding:2px;">Type</label>
        <select style="padding:2px;" name="ch${i}_type">
          <option value="di" ${ch.type === 'di' ? 'selected' : ''}>DI</option>
          <option value="do" ${ch.type === 'do' ? 'selected' : ''}>DO</option>
          <option value="aio" ${ch.type === 'aio' ? 'selected' : ''}>AIO</option>
        </select>
        <label style="padding:2px;">I2C Address</label>
        <input style="padding:2px;" name="ch${i}_address" value="${ch.address_hex || ""}" />
      </div>
    `;
  });
  html += `<button type="submit">Save</button></form>`;
  controls.innerHTML = html;

  // Handle form submit
  controls.querySelector("#expander_settings_form").onsubmit = async function(e) {
    e.preventDefault();
    // Gather data
    const form = e.target;
    const payload = {
      name: form.name.value,
      address_hex: form.address_hex.value,
      channels: exp.channels.map((ch, i) => ({
        name: form[`ch${i}_name`].value,
        type: form[`ch${i}_type`].value,
        address_hex: form[`ch${i}_address`].value
      }))
    };
    // Save
    const saveRes = await fetch("/api/expansion_config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const saveData = await saveRes.json();
    if (saveData.ok) {
      alert("Expansion config saved!");
      hideIoChannelPopup();
    } else {
      alert("Save failed: " + (saveData.error || "Unknown error"));
    }
  };

  popup.classList.add('active');
  overlay.style.display = 'block';
}
window.showExpanderSettingsPopup = showExpanderSettingsPopup;
window.onExtClick = onExtClick;

function onExpanderBackClick(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();

  closeModal();
  _clearAnyDimState();

  const headCard = document.getElementById("head_module_card");
  if (!headCard || !_originalHeadModuleHTML) return;

  headCard.innerHTML = _originalHeadModuleHTML;
  attachExtClickHandler();

  _clearAnyDimState();
}
window.onExpanderBackClick = onExpanderBackClick;

// ============================================================
// BOOT
// ============================================================

_clearAnyDimState();
loadStatus();
loadModules();
setInterval(loadStatus, 4000);

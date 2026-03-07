// ------------------ Unified IO Channel Popup Modal ------------------
// This section implements a unified popup modal for displaying and configuring IO channels (DI/DO/AIO/I2C).
// The same popup structure is reused for both per-channel quick settings (clicking on a channel) and full module settings (gear icon).
// DIP switch toggle logic for Add Module page
function toggleDip(idx) {
  const slider = document.getElementById(`dip${idx}_slider`);
  const val = document.getElementById(`dip${idx}`);
  const state = document.getElementById(`dip${idx}_val`);
  if (!slider || !val || !state) return;
  // Toggle value
  val.value = val.value === "1" ? "0" : "1";
  // Update slider visual
  slider.classList.toggle("dipswitch-on", val.value === "1");
  slider.classList.toggle("dipswitch-off", val.value !== "1");
  // Update state text
  state.textContent = val.value === "1" ? "ON" : "OFF";
  // Update address display
  updateDipAddressDisplay();
}

function updateDipAddressDisplay() {
  const dip1 = Number(document.getElementById("dip1")?.value || 0); // DIP1: CLOSED=0, OPEN=1
  const dip2 = Number(document.getElementById("dip2")?.value || 0); // DIP2: CLOSED=0, OPEN=1
  const dip3 = Number(document.getElementById("dip3")?.value || 0); // DIP3: CLOSED=0, OPEN=1
  // Get module type
  const typeSel = document.getElementById("add_type");
  const type = typeSel ? typeSel.value : "di";
  // Set base address per module type
  let base = 0x20; // Default DI
  if (type === "do") base = 0x30;
  else if (type === "aio") base = 0x40;
  else if (type === "rs485") base = 0x50;
  else if (type === "ext") base = 0x60; // I2C Module
  else if (type === "genmon") base = 0x01; // Generac default RS485 addr starts at 1
  // Address mapping: DIP1*1 + DIP2*2 + DIP3*4
  const addrNum = base + dip1*1 + dip2*2 + dip3*4;
  const addr = type === "genmon"
    ? `${addrNum}`
    : "0x" + addrNum.toString(16).toUpperCase();
  const display = document.getElementById("address_display");
  if (display) display.textContent = `Address: ${addr}`;
}

// Update address when module type changes
document.addEventListener("DOMContentLoaded", function() {
  updateDipAddressDisplay();
  const typeSel = document.getElementById("add_type");
  if (typeSel) typeSel.addEventListener("change", updateDipAddressDisplay);
});
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

// Ensure a single top-left remove button; removed when no module_id is present
function ensureRemoveButton(popup, ctx) {
  let btn = popup.querySelector('.popup-remove-top');
  if (!ctx || !ctx.module_id) {
    if (btn) btn.remove();
    return null;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'popup-remove-top danger';
    btn.textContent = 'Remove';
    popup.appendChild(btn);
  }
  btn.onclick = async () => {
    if (!confirm('Remove this module? This cannot be undone.')) return;
    btn.disabled = true;
    try {
      const res = await fetch('/modules/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ctx.module_id }),
      });
      const data = await res.json();
      if (data && data.ok) {
        alert('Module removed.');
        hideIoChannelPopup();
        if (typeof loadModules === 'function') loadModules();
      } else {
        alert('Failed to remove module: ' + (data && data.error ? data.error : 'Unknown error'));
      }
    } catch (e) {
      alert('Network error removing module: ' + e);
    } finally {
      btn.disabled = false;
    }
  };
  return btn;
}

// Global state holders
const MODULE_SVGS = new Map();
let MODAL_CTX = { id: null, type: null, address: null, name: null };

// Utility: clear any dimming/selection states safely
function _clearAnyDimState() {
  document.querySelectorAll('.dim, .dimmed').forEach((el) => {
    el.classList.remove('dim');
    el.classList.remove('dimmed');
  });
}

// Utility: scope <style> rules inside fetched SVGs to avoid leaking to the page
function scopeSvgStyles(svgRoot, scopeClass) {
  if (!svgRoot) return;
  svgRoot.classList.add(scopeClass);
  svgRoot.querySelectorAll('style').forEach((styleEl) => {
    const scoped = (styleEl.textContent || '')
      .split('}')
      .map((rule) => rule.trim())
      .filter(Boolean)
      .map((rule) => {
        const parts = rule.split('{');
        if (parts.length !== 2) return rule;
        const sel = parts[0].trim();
        const body = parts[1].trim();
        const scopedSel = sel
          .split(',')
          .map((s) => `.${scopeClass} ${s.trim()}`)
          .join(', ');
        return `${scopedSel} { ${body} }`;
      })
      .join(' ');
    styleEl.textContent = scoped;
  });
}

// Utility: ensure SVG is visible (Safari sometimes collapses 0x0)
function ensureSvgVisible(svgRoot) {
  if (!svgRoot) return;
  if (!svgRoot.getAttribute('width')) svgRoot.setAttribute('width', '100%');
  if (!svgRoot.getAttribute('height')) svgRoot.setAttribute('height', '100%');
  svgRoot.style.display = 'block';
}

/**
 * Show IO Channel Popup with controls for DI/DO/AIO/I2C
 * @param {object|string} name - Channel name or context object
 * @param {string} [status] - Channel status (if name is string)
 */
async function showIoChannelPopup(name, status) {
  const popup = ensureIoChannelPopup();
  const overlay = ensureIoChannelPopupOverlay();
  const controls = popup.querySelector('.popup-controls');
  if (!controls) return;

  let ctx = typeof name === 'object' ? name : { name, status };
  ensureRemoveButton(popup, ctx);

  // Reset base UI
  popup.querySelectorAll('.popup-close').forEach((btn) => btn.remove());
  controls.innerHTML = '';
  popup.querySelector('.popup-title').textContent = '';
  popup.querySelector('.popup-status').textContent = '';
  overlay.onclick = (e) => { if (e.target === overlay) hideIoChannelPopup(); };

  const activatePopup = () => {
    popup.classList.add('active');
    overlay.style.display = 'block';
    document.body.classList.add('modal-open');
  };

  // ------------------------------------------------------------
  // Per-channel quick popup
  // ------------------------------------------------------------
  if (ctx.channel) {
    popup.querySelector('.popup-title').textContent = ctx.name || `Channel ${ctx.channel}`;
    popup.querySelector('.popup-status').textContent = ctx.status ? `Status: ${ctx.status}` : '';

    // I2C module: show live sensor replies instead of override/invert controls
    if (ctx.type === 'i2c') {
      controls.innerHTML = `<div style="min-width:280px">Loading sensor data…</div>`;
      try {
        const r = await fetch(`/api/module_read/${encodeURIComponent(ctx.module_id)}`);
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);

        const samples = Array.isArray(data.samples) ? data.samples : [];
        const registered = Array.isArray(data.registered) ? data.registered : [];
        const scan = Array.isArray(data.scan_found) ? data.scan_found : [];

        const fieldNames = {
          0x01: "Voltage (mV)",
          0x02: "Current (mA)",
          0x03: "ADC0",
          0x04: "ADC1",
          0x05: "ADC2",
          0x06: "ADC3",
          0x07: "Temp (0.01°C)",
          0x08: "Humidity (0.01%)",
          0x09: "Pressure (Pa)",
          0x0A: "Gas (Ω)",
          0x0B: "GPIO Low",
          0x0C: "GPIO High",
          0x0D: "GPIO Pin",
          0x0E: "Scan Found",
          0x0F: "Config Saved",
          0x10: "Config Deleted",
          0x11: "Registry Entry",
          0x12: "Registry Cleared",
        };

        const sampleRows = samples.map((s, i) => {
          const fld = Number(s.field || 0);
          const name = fieldNames[fld] || `Field 0x${fld.toString(16)}`;
          const sensorName = s.sensor_name || `0x${Number(s.sensor_type || 0).toString(16)}`;
          return `<tr>
            <td>${i + 1}</td>
            <td>${sensorName}</td>
            <td>0x${Number(s.i2c_addr || 0).toString(16)}</td>
            <td>${name}</td>
            <td>${s.value}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="5" class="muted">No samples returned.</td></tr>`;

        const regRows = registered.map((d, i) => {
          const sensorName = d.sensor_name || `0x${Number(d.sensor_type || 0).toString(16)}`;
          return `<tr>
            <td>${i + 1}</td>
            <td>${sensorName}</td>
            <td>0x${Number(d.i2c_addr || 0).toString(16)}</td>
            <td>${d.options ?? ""}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="4" class="muted">No registered devices.</td></tr>`;

        const scanList = scan.length ? scan.map((a) => `0x${Number(a).toString(16)}`).join(", ") : "None";

        controls.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:10px;min-width:320px;max-width:540px">
            <div><b>Name:</b> ${ctx.name || `Channel ${ctx.channel}`}</div>
            <div class="muted">Latest sensor replies from the I2C module.</div>
            <div style="max-height:220px;overflow:auto;border:1px solid #333;padding:6px;border-radius:8px;">
              <div style="font-weight:700;margin-bottom:4px;">Samples</div>
              <table style="width:100%;font-size:12px;border-collapse:collapse;">
                <thead><tr><th>#</th><th>Sensor</th><th>Addr</th><th>Field</th><th>Value</th></tr></thead>
                <tbody>${sampleRows}</tbody>
              </table>
            </div>
            <div style="max-height:140px;overflow:auto;border:1px solid #333;padding:6px;border-radius:8px;">
              <div style="font-weight:700;margin-bottom:4px;">Registered Devices</div>
              <table style="width:100%;font-size:12px;border-collapse:collapse;">
                <thead><tr><th>#</th><th>Sensor</th><th>Addr</th><th>Options</th></tr></thead>
                <tbody>${regRows}</tbody>
              </table>
            </div>
            <div><b>Scan:</b> ${scanList}</div>
          </div>
        `;
      } catch (err) {
        controls.innerHTML = `<div style="color:#ff6b6b;min-width:280px">Error: ${err}</div>`;
      }

      const closeBtn = document.createElement('button');
      closeBtn.className = 'popup-close channel';
      closeBtn.textContent = 'Close';
      closeBtn.onclick = hideIoChannelPopup;
      popup.appendChild(closeBtn);
      overlay.onclick = (e) => { if (e.target === overlay) hideIoChannelPopup(); };
      activatePopup();
      return;
    }

    controls.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;min-width:240px">
        <div><b>Name:</b> ${ctx.name || `Channel ${ctx.channel}`}</div>
        <label style="display:flex;align-items:center;gap:8px">
          <span style="min-width:70px;">Override</span>
          <select id="ch_override">
            <option value="none">None</option>
            <option value="on">Force ON</option>
            <option value="off">Force OFF</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="ch_invert" />
          <span>Invert</span>
        </label>
      </div>
    `;

    const overrideSel = controls.querySelector('#ch_override');
    const invertSel = controls.querySelector('#ch_invert');

    // Load existing override/invert for DI/DO
    async function fetchAndSetChannelState() {
      if (!ctx.module_id || !ctx.channel) return;
      try {
        const r = await fetch(`/api/module_config_get?module_id=${encodeURIComponent(ctx.module_id)}`);
        const data = await r.json();
        if (!r.ok || !data.ok) return;
        const inv = data.invert && data.invert[String(ctx.channel)];
        const ov = data.override && data.override[String(ctx.channel)];
        if (invertSel) invertSel.checked = !!inv;
        if (overrideSel && typeof ov === 'string') overrideSel.value = ov;
      } catch (e) {
        /* ignore */
      }
    }
    if (ctx.type === 'di' || ctx.type === 'do') fetchAndSetChannelState();

    async function saveChannelState() {
      if (!ctx.module_id || !(ctx.type === 'di' || ctx.type === 'do')) {
        return { ok: true }; // nothing to save for other types
      }
      const payload = {
        module_id: ctx.module_id,
        override: { [ctx.channel]: overrideSel.value },
        invert: { [ctx.channel]: !!invertSel.checked },
      };
      const resp = await fetch('/api/module_config_set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      return { ok: resp.ok && data.ok, error: data.error };
    }

    // Close button
    const channelCloseBtn = document.createElement('button');
    channelCloseBtn.className = 'popup-close channel';
    channelCloseBtn.textContent = ctx.type === 'di' || ctx.type === 'do' ? 'Save & Close' : 'Close';
    channelCloseBtn.onclick = async () => {
      channelCloseBtn.disabled = true;
      if (ctx.type === 'di' || ctx.type === 'do') {
        const res = await saveChannelState();
        if (!res.ok) {
          alert(res.error || 'Save failed');
          channelCloseBtn.disabled = false;
          return;
        }
        window._lastModuleConfigPopupReload = Date.now();
        if (typeof loadModules === 'function') loadModules();
      }
      hideIoChannelPopup();
    };
    popup.appendChild(channelCloseBtn);

    // Save when overlay clicked
    overlay.onclick = async (e) => {
      if (e.target !== overlay) return;
      const res = await saveChannelState();
      if (!res.ok) {
        alert(res.error || 'Save failed');
        return;
      }
      hideIoChannelPopup();
    };

    activatePopup();
    return;
  }

  // ------------------------------------------------------------
  // Global popup (gear icon)
  // ------------------------------------------------------------
  if (!ctx.module_id || !ctx.type) {
    // Try to fill from existing modules
    for (const [modId, modInfo] of MODULE_SVGS.entries()) {
      if (!ctx.type || modInfo.type === ctx.type) {
        ctx.module_id = modId;
        ctx.type = modInfo.type;
        break;
      }
    }
  }
  ensureRemoveButton(popup, ctx);

  const type = (ctx.type || '').toLowerCase();
  popup.querySelector('.popup-title').textContent = ctx.name || name || `${type.toUpperCase()} MODULE`;
  popup.querySelector('.popup-status').textContent = ctx.status ? `Status: ${ctx.status}` : '';
  controls.innerHTML = '<div>Loading…</div>';

  const urlMap = {
    di: '/di_config_popup',
    do: '/do_config_popup',
    aio: '/aio_config_popup',
    ext: '/i2c_config_popup',
    i2c: '/i2c_config_popup',
    rs485: '/rs485_config_popup',
    genmon: '/genmon_config_popup',
  };
  const url = urlMap[type];
  if (!url) {
    controls.innerHTML = '<div>No config popup for this module type.</div>';
    activatePopup();
    return;
  }

  let html = '';
  try {
    const resp = await fetch(url);
    html = await resp.text();
  } catch (e) {
    controls.innerHTML = '<div>Failed to load config popup.</div>';
    activatePopup();
    return;
  }

  controls.innerHTML = html;
  const form = controls.querySelector('form');
  if (!form) {
    controls.innerHTML = '<div>No config popup for this module type or module_id missing.</div>';
    activatePopup();
    return;
  }

  // ---------------- DI/DO global config ----------------
  if (type === 'di' || type === 'do') {
    const nameInput = form.querySelector('input[name="module_name"]');
    const addressSpan = form.querySelector('#address_value');
    const modNumSel = form.querySelector('select[name="module_num"]');
    const baseAddr = type === 'di' ? 0x20 : 0x30;
    let targetAddr = ctx.address;
    if (nameInput && ctx.name) nameInput.value = ctx.name;
    if (addressSpan && ctx.address) addressSpan.textContent = ctx.address;
    if (modNumSel && ctx.module_num) modNumSel.value = String(ctx.module_num);
    _applyDipsFromAddress(form, baseAddr, ctx.address);
    _wireDipSwitches(form, baseAddr, {
      onChange: (addr) => { targetAddr = addr; },
    });

    // Pre-fill invert/override + names
    async function loadConfig() {
      if (!ctx.module_id) return;
      try {
        const r = await fetch(`/api/module_config_get?module_id=${encodeURIComponent(ctx.module_id)}`);
        const data = await r.json();
        if (r.ok && data.ok) {
          for (let i = 1; i <= 16; i++) {
            const ovSel = form.querySelector(`[name='ch${i}_override']`);
            const invChk = form.querySelector(`[name='ch${i}_invert']`);
            if (ovSel && data.override && data.override[String(i)]) {
              ovSel.value = data.override[String(i)];
            }
            if (invChk && data.invert) {
              invChk.checked = !!data.invert[String(i)];
            }
          }
        }
      } catch (e) { /* ignore */ }

      // Load labels for channel names
      try {
        const lr = await fetch(`/labels/${encodeURIComponent(ctx.module_id)}`);
        const ld = await lr.json();
        if (lr.ok && ld.ok && ld.labels) {
          if (nameInput && typeof ld.labels.module_name === 'string') {
            nameInput.value = ld.labels.module_name;
          }
          const ch = ld.labels.channels || {};
          for (let i = 1; i <= 16; i++) {
            const nEl = form.querySelector(`[name='ch${i}']`);
            if (nEl && typeof ch[String(i)] === 'string') nEl.value = ch[String(i)];
          }
        }
      } catch (e) { /* ignore */ }
    }

    const saveBtn = controls.querySelector('.di-global-save') || controls.querySelector('.do-global-save') || controls.querySelector('button[type="submit"]');
    if (saveBtn) {
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save';
      saveBtn.onclick = async () => {
        if (!ctx.module_id) return;
        // Rename if needed
        const newName = nameInput ? (nameInput.value || '').trim() : '';
        if (newName && newName !== (ctx.name || '')) {
          try {
            await fetch('/modules/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: ctx.module_id, name: newName }),
            });
            ctx.name = newName;
          } catch (e) { /* ignore rename errors */ }
        }

        // Change address if DIP changed
        if (targetAddr && targetAddr !== ctx.address) {
          try {
            const resp = await fetch('/modules/change_address', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: ctx.module_id, address: targetAddr }),
            });
            const dj = await resp.json();
            if (resp.ok && dj && dj.ok && dj.module) {
              ctx.address = dj.module.address;
              ctx.module_id = dj.module.id || ctx.module_id;
            } else {
              ctx.address = targetAddr;
            }
          } catch (e) { /* ignore */ }
        }

        // Collect invert/override
        const invert = {};
        const override = {};
        const channelNames = {};
        for (let i = 1; i <= 16; i++) {
          const invChk = form.querySelector(`[name='ch${i}_invert']`);
          const ovSel = form.querySelector(`[name='ch${i}_override']`);
          const nm = form.querySelector(`[name='ch${i}']`);
          invert[i] = !!(invChk && invChk.checked);
          override[i] = ovSel ? ovSel.value : 'none';
          channelNames[i] = nm ? nm.value || '' : '';
        }

        await fetch('/api/module_config_set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module_id: ctx.module_id, invert, override }),
        });

        await fetch('/labels/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            module_id: ctx.module_id,
            module_name: newName,
            channels: channelNames,
          }),
        });

        // Save module id (1-10 unique)
        if (modNumSel) {
          const numVal = modNumSel.value;
          const resNum = await _saveModuleNum(ctx.module_id, numVal);
          if (!resNum.ok) {
            alert(resNum.error || 'Failed to save Module ID');
            return;
          }
        }

        window._lastModuleConfigPopupReload = Date.now();
        if (typeof loadModules === 'function') loadModules();
        hideIoChannelPopup();
      };
    }

    loadConfig();
    activatePopup();
    return;
  }

  // ---------------- AIO global config ----------------
  if (type === 'aio') {
    // Remove template submit/cancel buttons to avoid duplicates
    form.querySelectorAll('button[type="submit"], button[type="button"]').forEach((btn) => btn.remove());

    const nameInput = form.querySelector('input[name="module_name"]');
    const addrInput = form.querySelector('input[name="i2c_address"]');
    const modNumSel = form.querySelector('select[name="module_num"]');
    const addrSpan = form.querySelector('#address_value');
    const baseAddr = 0x40;
    let targetAddr = ctx.address;
    if (nameInput && ctx.name) nameInput.value = ctx.name;
    if (addrInput && ctx.address) addrInput.value = ctx.address;
    if (addrSpan && ctx.address) addrSpan.textContent = ctx.address;
    if (modNumSel && ctx.module_num) modNumSel.value = String(ctx.module_num);
    _applyDipsFromAddress(form, baseAddr, ctx.address);
    _wireDipSwitches(form, baseAddr, {
      onChange: (addr) => { targetAddr = addr; if (addrSpan) addrSpan.textContent = addr; if (addrInput) addrInput.value = addr; },
    });

    let saveBtn = controls.querySelector('.aio-global-save');
    if (!saveBtn) {
      saveBtn = document.createElement('button');
      saveBtn.className = 'global-save aio-global-save';
      saveBtn.textContent = 'Save';
      controls.appendChild(saveBtn);
    } else {
      saveBtn.className = 'global-save aio-global-save';
      saveBtn.textContent = 'Save';
    }

    const clampMax = (n) => {
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.min(n, 24);
    };

    function fillMaxInputs(data) {
      for (let i = 1; i <= 8; i++) {
        const vIn = data && data.in ? data.in[String(i)] : undefined;
        const vOut = data && data.out ? data.out[String(i)] : undefined;
        const inEl = form.querySelector(`[name='in${i}_maxv']`);
        const outEl = form.querySelector(`[name='out${i}_maxv']`);
        if (inEl) inEl.value = (vIn !== undefined && vIn !== null) ? vIn : '';
        if (outEl) outEl.value = (vOut !== undefined && vOut !== null) ? vOut : '';
      }
    }

    async function loadAioMaxConfig() {
        if (!ctx.module_id) return;
        if (targetAddr && targetAddr !== ctx.address) {
          try {
            const resp = await fetch('/modules/change_address', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: ctx.module_id, address: targetAddr }),
            });
            const dj = await resp.json();
            if (resp.ok && dj && dj.ok && dj.module) {
              ctx.address = dj.module.address;
              ctx.module_id = dj.module.id || ctx.module_id;
            } else {
              ctx.address = targetAddr;
            }
          } catch (e) { /* ignore */ }
        }
      try {
        const res = await fetch(`/api/aio_max_voltage/${encodeURIComponent(ctx.module_id)}`);
        const data = await res.json();
        if (res.ok && data && data.ok) {
          fillMaxInputs(data.data || { in: {}, out: {} });
        }
      } catch (e) {
        /* ignore */
      }
    }

    function collectAioMaxConfig() {
      const out = { in: {}, out: {} };
      for (let i = 1; i <= 8; i++) {
        const inEl = form.querySelector(`[name='in${i}_maxv']`);
        const outEl = form.querySelector(`[name='out${i}_maxv']`);
        if (inEl) {
          const n = clampMax(parseFloat(inEl.value));
          if (n !== null) out.in[i] = n;
        }
        if (outEl) {
          const n = clampMax(parseFloat(outEl.value));
          if (n !== null) out.out[i] = n;
        }
      }
      return out;
    }

    async function saveAio() {
      if (!ctx.module_id) return false;
      let currentModuleId = ctx.module_id;

      const newName = nameInput ? String(nameInput.value || '').trim() : '';
      const newAddr = addrInput ? String(addrInput.value || '').trim() : '';

      // Rename if changed
      if (newName && newName !== (ctx.name || '')) {
        try {
          const resp = await fetch('/modules/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentModuleId, name: newName }),
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) {
            alert(data && data.error ? data.error : 'Rename failed');
            return false;
          }
          ctx.name = newName;
        } catch (e) {
          alert('Network error renaming module');
          return false;
        }
      }

      // Address change if requested
      if (newAddr && newAddr !== (ctx.address || '')) {
        try {
          const resp = await fetch('/modules/change_address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentModuleId, address: newAddr }),
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) {
            alert(data && data.error ? data.error : 'Address change failed');
            return false;
          }
          // update ctx with new module id/address
          currentModuleId = data.module.id;
          ctx.module_id = data.module.id;
          ctx.address = data.module.address;
          if (addrInput) addrInput.value = data.module.address;
        } catch (e) {
          alert('Network error changing address');
          return false;
        }
      }

      // Save module number
      if (modNumSel) {
        const numVal = modNumSel.value;
        const rnum = await _saveModuleNum(currentModuleId, numVal);
        if (!rnum.ok) {
          alert(rnum.error || 'Failed to save Module ID');
          return false;
        }
      }

      const payload = collectAioMaxConfig();
      try {
        const resp = await fetch(`/api/aio_max_voltage/${encodeURIComponent(currentModuleId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          alert(data && data.error ? data.error : 'Save failed');
          return false;
        }
      } catch (e) {
        alert('Network error saving AIO settings');
        return false;
      }
      return true;
    }

    let saving = false;
    saveBtn.onclick = async () => {
      if (saving) return;
      saving = true;
      const oldText = saveBtn.textContent;
      saveBtn.textContent = 'Saving...';
      const ok = await saveAio();
      saveBtn.textContent = oldText;
      saving = false;
      if (ok) {
        window._lastModuleConfigPopupReload = Date.now();
        if (typeof loadModules === 'function') loadModules();
        hideIoChannelPopup();
      }
    };

    loadAioMaxConfig();
    activatePopup();
    return;
  }

  // ---------------- I2C / Expansion global config ----------------
  if (type === 'ext' || type === 'i2c') {
    form.querySelectorAll('button[type="submit"], button[type="button"]').forEach((btn) => btn.remove());
    const nameInput = form.querySelector('input[name="module_name"]');
    const addrInput = form.querySelector('input[name="i2c_address"]');
    const modNumSel = form.querySelector('select[name="module_num"]');
    const baseAddr = 0x60;
    if (modNumSel && ctx.module_num) modNumSel.value = String(ctx.module_num);
    _applyDipsFromAddress(form, baseAddr, ctx.address);
    _wireDipSwitches(form, baseAddr, {
      onChange: (addr) => { if (addrInput) addrInput.value = addr; },
    });

    let saveBtn = controls.querySelector('.ext-global-save');
    if (!saveBtn) {
      saveBtn = document.createElement('button');
      saveBtn.className = 'global-save ext-global-save';
      saveBtn.textContent = 'Save';
      controls.appendChild(saveBtn);
    } else {
      saveBtn.className = 'global-save ext-global-save';
      saveBtn.textContent = 'Save';
    }

    function fillForm(exp) {
      if (nameInput) nameInput.value = exp.name || '';
      if (addrInput) addrInput.value = exp.address_hex || '';
      for (let i = 0; i < 8; i++) {
        const ch = (exp.channels && exp.channels[i]) || {};
        const n = form.querySelector(`[name='ch${i+1}']`);
        const t = form.querySelector(`[name='type${i+1}']`);
        const a = form.querySelector(`[name='addr${i+1}']`);
        if (n) n.value = ch.name || '';
        if (t) t.value = ch.type || 'di';
        if (a) a.value = ch.address_hex || '';
      }
    }

    async function loadExtConfig() {
      try {
        const res = await fetch('/api/expansion_config');
        const data = await res.json();
        if (res.ok && data && data.ok) fillForm(data.exp || {});
      } catch (e) { /* ignore */ }
    }

    function collectExtConfig() {
      const channels = [];
      for (let i = 0; i < 8; i++) {
        const n = form.querySelector(`[name='ch${i+1}']`);
        const t = form.querySelector(`[name='type${i+1}']`);
        const a = form.querySelector(`[name='addr${i+1}']`);
        channels.push({
          name: n ? n.value : '',
          type: t ? t.value : 'di',
          address_hex: a ? a.value : '',
        });
      }
      return {
        name: nameInput ? nameInput.value : '',
        address_hex: addrInput ? addrInput.value : '',
        channels,
      };
    }

    async function saveExt() {
      const payload = collectExtConfig();
      try {
        const resp = await fetch('/api/expansion_config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          alert(data && data.error ? data.error : 'Save failed');
          return false;
        }
        if (modNumSel) {
          const rnum = await _saveModuleNum(ctx.module_id, modNumSel.value);
          if (!rnum.ok) {
            alert(rnum.error || 'Failed to save Module ID');
          }
        }
      } catch (e) {
        alert('Network error saving expansion config');
        return false;
      }
      return true;
    }

    let saving = false;
    saveBtn.onclick = async () => {
      if (saving) return;
      saving = true;
      const old = saveBtn.textContent;
      saveBtn.textContent = 'Saving...';
      const ok = await saveExt();
      saveBtn.textContent = old;
      saving = false;
      if (ok) {
        window._lastModuleConfigPopupReload = Date.now();
        if (typeof loadModules === 'function') loadModules();
        hideIoChannelPopup();
      }
    };

    loadExtConfig();
    activatePopup();
    return;
  }

  // ---------------- RS485 global config ----------------
  if (type === 'rs485') {
    form.querySelectorAll('button[type="submit"], button[type="button"]').forEach((btn) => btn.remove());
    const nameInput = form.querySelector('input[name="module_name"]');
    const addrSpan = form.querySelector('#address_value');
    const modNumSel = form.querySelector('select[name="module_num"]');
    const baseAddr = 0x50;
    let targetAddr = ctx.address;
    if (nameInput && ctx.name) nameInput.value = ctx.name;
    if (addrSpan && ctx.address) addrSpan.textContent = ctx.address;
    if (modNumSel && ctx.module_num) modNumSel.value = String(ctx.module_num);
    _applyDipsFromAddress(form, baseAddr, ctx.address);
    _wireDipSwitches(form, baseAddr, {
      onChange: (addr) => { targetAddr = addr; if (addrSpan) addrSpan.textContent = addr; },
    });

    let saveBtn = controls.querySelector('.rs485-global-save');
    if (!saveBtn) {
      saveBtn = document.createElement('button');
      saveBtn.className = 'global-save rs485-global-save';
      saveBtn.textContent = 'Save';
      controls.appendChild(saveBtn);
    } else {
      saveBtn.className = 'global-save rs485-global-save';
      saveBtn.textContent = 'Save';
    }

    // Load labels to prefill names
    async function loadRs485Labels() {
      if (!ctx.module_id) return;
      try {
        const lr = await fetch(`/labels/${encodeURIComponent(ctx.module_id)}`);
        const ld = await lr.json();
        if (lr.ok && ld.ok && ld.labels) {
          if (nameInput && typeof ld.labels.module_name === 'string') {
            nameInput.value = ld.labels.module_name;
          }
          const ch = ld.labels.channels || {};
          for (let i = 1; i <= 4; i++) {
            const nEl = form.querySelector(`[name='ch${i}']`);
            if (nEl && typeof ch[String(i)] === 'string') nEl.value = ch[String(i)];
          }
        }
      } catch (e) { /* ignore */ }
    }

    saveBtn.onclick = async () => {
      if (!ctx.module_id) return;
      const newName = nameInput ? (nameInput.value || '').trim() : '';
      // Rename module if changed
      if (newName && newName !== (ctx.name || '')) {
        try {
          await fetch('/modules/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.module_id, name: newName }),
          });
          ctx.name = newName;
        } catch (e) { /* ignore rename errors */ }
      }

      // Collect channel labels (4)
      const channels = {};
      for (let i = 1; i <= 4; i++) {
        const nEl = form.querySelector(`[name='ch${i}']`);
        channels[i] = nEl ? nEl.value || `CH${i}` : `CH${i}`;
      }

      if (targetAddr && targetAddr !== ctx.address) {
        try {
          const resp = await fetch('/modules/change_address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.module_id, address: targetAddr }),
          });
          const dj = await resp.json();
          if (resp.ok && dj && dj.ok && dj.module) {
            ctx.address = dj.module.address;
            ctx.module_id = dj.module.id || ctx.module_id;
          } else {
            ctx.address = targetAddr;
          }
        } catch (e) { /* ignore */ }
      }

      await fetch('/labels/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_id: ctx.module_id,
          module_name: newName,
          channels,
        }),
      });

      if (modNumSel) {
        const resNum = await _saveModuleNum(ctx.module_id, modNumSel.value);
        if (!resNum.ok) {
          alert(resNum.error || 'Failed to save Module ID');
          return;
        }
      }

      window._lastModuleConfigPopupReload = Date.now();
      if (typeof loadModules === 'function') loadModules();
      hideIoChannelPopup();
    };

    loadRs485Labels();
    activatePopup();
    return;
  }

  // ---------------- Generator detail popup helper ----------------
  async function showGenmonDetailPopup(moduleId) {
    const popup = ensureIoChannelPopup();
    const overlay = ensureIoChannelPopupOverlay();
    const controls = popup.querySelector('.popup-controls');
    popup.querySelector('.popup-title').textContent = 'Generator Details';
    popup.querySelector('.popup-status').textContent = '';
    controls.innerHTML = `
      <iframe src="/modules/genmon/${encodeURIComponent(moduleId)}/detail"
              style="width:520px;height:420px;border:0;background:#fff;"></iframe>
    `;
    popup.querySelectorAll('.popup-close').forEach((btn) => btn.remove());
    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close global';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = hideIoChannelPopup;
    popup.appendChild(closeBtn);
    popup.classList.add('active');
    overlay.style.display = 'block';
    overlay.onclick = (e) => { if (e.target === overlay) hideIoChannelPopup(); };
    document.body.classList.add('modal-open');
  }

  // ---------------- Generator global config ----------------
  if (type === 'genmon') {
    form.querySelectorAll('button[type="submit"], button[type="button"]').forEach((btn) => btn.remove());
    const nameInput = form.querySelector('input[name="module_name"]');
    const addrInput = form.querySelector('input[name="i2c_address"]');
    const addrSpan = form.querySelector('#address_value');
    const modNumSel = form.querySelector('select[name="module_num"]');
    const baseAddr = 0x01;
    let targetAddr = ctx.address;
    if (nameInput && ctx.name) nameInput.value = ctx.name;
    if (addrInput && ctx.address) addrInput.value = ctx.address;
    if (addrSpan && ctx.address) addrSpan.textContent = ctx.address;
    if (modNumSel && ctx.module_num) modNumSel.value = String(ctx.module_num);
    _applyDipsFromAddress(form, baseAddr, ctx.address);
    _wireDipSwitches(form, baseAddr, {
      format: 'dec',
      onChange: (addr) => { targetAddr = addr; if (addrInput) addrInput.value = addr; if (addrSpan) addrSpan.textContent = addr; },
    });

    let saveBtn = controls.querySelector('.genmon-global-save');
    if (!saveBtn) {
      saveBtn = document.createElement('button');
      saveBtn.className = 'global-save genmon-global-save';
      saveBtn.textContent = 'Save';
      controls.appendChild(saveBtn);
    } else {
      saveBtn.className = 'global-save genmon-global-save';
      saveBtn.textContent = 'Save';
    }

    saveBtn.onclick = async () => {
      if (!ctx.module_id) return;
      const newName = nameInput ? (nameInput.value || '').trim() : '';
      const newAddr = (addrInput ? (addrInput.value || '').trim() : '') || targetAddr;

      if (newName && newName !== (ctx.name || '')) {
        try {
          await fetch('/modules/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.module_id, name: newName }),
          });
          ctx.name = newName;
        } catch (e) { /* ignore rename errors */ }
      }

      if (newAddr && newAddr !== (ctx.address || '')) {
        try {
          const resp = await fetch('/modules/change_address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.module_id, address: newAddr }),
          });
          const dj = await resp.json();
          if (resp.ok && dj && dj.ok && dj.module) {
            ctx.address = dj.module.address;
            ctx.module_id = dj.module.id || ctx.module_id;
          } else {
            ctx.address = newAddr;
          }
        } catch (e) { /* ignore address errors */ }
      }

      if (modNumSel) {
        const resNum = await _saveModuleNum(ctx.module_id, modNumSel.value);
        if (!resNum.ok) {
          alert(resNum.error || 'Failed to save Module ID');
          return;
        }
      }

      window._lastModuleConfigPopupReload = Date.now();
      if (typeof loadModules === 'function') loadModules();
      hideIoChannelPopup();
    };

    activatePopup();
    return;
  }

  // Fallback for unknown types
  controls.innerHTML = '<div>No config popup for this module type.</div>';
  activatePopup();
}

function hideIoChannelPopup() {
  const popup = document.querySelector('.io-channel-popup');
  const overlay = document.querySelector('.io-channel-popup-overlay');
  if (popup) {
    popup.classList.remove('active');
    const removeBtn = popup.querySelector('.popup-remove-top');
    if (removeBtn) removeBtn.remove();
    // Remove all close buttons
    popup.querySelectorAll('.popup-close').forEach(btn => btn.remove());
    // Clear controls and content
    popup.querySelector('.popup-controls').innerHTML = '';
    popup.querySelector('.popup-title').textContent = '';
    popup.querySelector('.popup-status').textContent = '';
  }
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active');

    // Restore default overlay click-to-close behavior (some popup flows override this)
    overlay.onclick = (e) => {
      if (e.target === overlay) hideIoChannelPopup();
    };

    // Undo any temporary "flash" styling
    overlay.style.background = 'rgba(0,0,0,0.01)';
  }
  document.body.classList.remove('modal-open');
}
window.showIoChannelPopup = showIoChannelPopup;
window.closePopup = hideIoChannelPopup;

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
    <svg id="head_svg" width="100" height="250" viewBox="0 0 100 250" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          #head_svg .card { fill:#eeeeee; stroke:none; }
          #head_svg .inner { fill:none; stroke:#d7d7d7; stroke-width:2; }
          #head_svg .title { font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:700; fill:#1a1a1a; }
          #head_svg .label { font-family:Arial,Helvetica,sans-serif; font-size:10px; font-weight:700; fill:#2a2a2a; }
          #head_svg .ledOuter { fill:#e7e7e7; stroke:#9c9c9c; stroke-width:2; }
          #head_svg .ledPwr { fill:#39d353; stroke:#222; stroke-width:2; }
          #head_svg .ledNet { fill:#2f81f7; stroke:#222; stroke-width:2; }
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

      <!-- Scale original 170x430 art to 100x250 and center -->
      <g transform="translate(0.6 0) scale(0.5813953488)">
        <rect class="card" x="0" y="0" width="170" height="430" rx="16"/>

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

          <text class="label" x="-6" y="80" text-anchor="end">9</text>
          <rect id="hat_mod_9" class="hat-off" x="0" y="72" width="16" height="10" rx="2"><title>Module 9</title></rect>

          <rect id="hat_mod_10" class="hat-off" x="36" y="72" width="16" height="10" rx="2"><title>Module 10</title></rect>
          <text class="label" x="58" y="80" text-anchor="start">10</text>
        </g>
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
      const [hr, er] = await Promise.all([
        fetch("/api/hat_status", { cache: "no-store" }),
        fetch("/api/module_errors", { cache: "no-store" }),
      ]);
      const hs = hr.ok ? await hr.json() : null;
      const errs = er.ok ? await er.json() : null;
      const errMap = (errs && errs.errors) || {};

      // Always wire up the hat slots so errors still display even if hat_status fails
      for (let i = 1; i <= 10; i++) {
        const el = svg.querySelector(`#hat_mod_${i}`);
        if (!el) continue;

        // Base fill from hat_status if available, otherwise default to grey
        let a = false, b = false;
        if (hs && hs.ok) {
          if (hs.modules && hs.modules[String(i)]) {
            a = !!hs.modules[String(i)]["24v_a"];
            b = !!hs.modules[String(i)]["24v_b"];
          } else if (hs.ports) {
            const ga = Number(hs.ports.gpio_a || 0);
            const gb = Number(hs.ports.gpio_b || 0);
            a = !!((ga >> (i - 1)) & 1);
            b = !!((gb >> (i - 1)) & 1);
          }
        }

        if (a && b) el.style.fill = "#39d353";
        else if (a && !b) el.style.fill = "#ffd43b";
        else if (!a && b) el.style.fill = "#ff4d4f";
        else el.style.fill = "#cfcfcf";

        // error overlay (apply even if hat_status failed)
        const errEntry = errMap[String(i)];
        if (errEntry && errEntry.error) {
            el.style.fill = "#ff4a4a";
            el.setAttribute("data-error", errEntry.error);
        } else {
            el.removeAttribute("data-error");
        }

        // click to show error (use getAttribute to support SVG elements)
        const hasErr = !!(errEntry && errEntry.error);
        el.style.cursor = hasErr ? "pointer" : "default";
        el.onclick = () => {
          const msg = el.getAttribute("data-error");
          if (msg) alert(`Module ${i} error: ${msg}`);
        };
      }

      const extEl = svg.querySelector("#hat_ext");
      const extEl2 = svg.querySelector("#hat_ext_2");
      const extFill = (hs && hs.ok && hs.ext_present) ? "#39d353" : "#cfcfcf";
      if (extEl) extEl.style.fill = extFill;
      if (extEl2) extEl2.style.fill = extFill;
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
let _TEST_PWR_ALT = false;
let _TEST_LINK_ALT = false;
let _TEST_BAT_PCT = 80;
let _TEST_BAT_PCT_DIR = -5;

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

    // Turn off status LEDs too
    _setStatusLed(root, ["status_pwr", "status_pwrA"], "off");
    _setStatusLed(root, ["status_link", "status_pwrB"], "off");
  }
}

function _setAllIndicators(on = true) {
  for (const [_mid, info] of MODULE_SVGS.entries()) {
    const root = info.svgRoot;
    if (!root) continue;

    const mt = String(info.type || "").toLowerCase();

    // Status LEDs
    if (on && ["aio", "di", "do"].includes(mt)) {
      // cycle PWR between yellow and green
      const pwrColor = _TEST_PWR_ALT ? "green" : "yellow";
      _setStatusLed(root, ["status_pwr", "status_pwrA"], pwrColor);
    } else {
      _setStatusLed(root, ["status_pwr", "status_pwrA"], on ? "green" : "off");
    }

    if (on) {
      // cycle LINK between red and green
      const linkColor = _TEST_LINK_ALT ? "green" : "red";
      _setStatusLed(root, ["status_link", "status_pwrB"], linkColor);
    } else {
      _setStatusLed(root, ["status_link", "status_pwrB"], "off");
    }

    if (mt === "genmon") {
      const sys = root.querySelector("#sys_led");
      const run = root.querySelector("#run_led");
      if (sys) {
        sys.classList.remove("led-on", "led-warn", "led-err", "led-off", "led-ok");
        sys.classList.add(on ? "led-ok" : "led-off");
      }
      if (run) {
        run.classList.remove("led-on", "led-warn", "led-err", "led-off", "led-run");
        run.classList.add(on ? "led-run" : "led-off");
      }
      _setGenmonBattery(root, on ? _TEST_BAT_PCT : 0);
      continue; // no channel circles on generator card
    }

    // Channel LEDs (all others)
    const circles = root.querySelectorAll("g[id^='ch'] circle.led, g[id^='ch'] circle.led-on, g[id^='ch'] circle.led-off");
    circles.forEach((el) => {
      el.classList.remove("led-on", "led-warn", "led-err", "led-off");
      el.classList.add(on ? "led-on" : "led-off");
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

function _setStatusLed(root, ids, state) {
  const colors = {
    green: { fill: "#38d26a", stroke: "#1d8f43" },
    yellow: { fill: "#ffd24a", stroke: "#c49a13" },
    red: { fill: "#ff4a4a", stroke: "#b51f1f" },
    off: { fill: "#d8d8d8", stroke: "#7a7a7a" },
  };
  const col = colors[state] || colors.off;
  const targets = Array.isArray(ids) ? ids : [ids];
  targets.forEach((id) => {
    const g = root.querySelector(`#${id}`);
    if (!g) return;
    const c = g.querySelector("circle");
    if (!c) return;
    c.classList.remove("led-on", "led-warn", "led-err", "led-off", "led-ok", "led-run");
    c.style.fill = col.fill;
    c.style.stroke = col.stroke;
  });
}

function _setGenmonBattery(root, percent) {
  const p = Math.max(0, Math.min(100, percent));
  const fill = root.querySelector("#bat_fill");
  const vText = root.querySelector("#bat_voltage");
  const pctText = root.querySelector("#bat_percent");
  // Map 0–100% to height 0–26 (SVG note in file) and y from 28..2
  const maxH = 26;
  const h = (p / 100) * maxH;
  if (fill) {
    fill.setAttribute("height", h.toFixed(1));
    fill.setAttribute("y", (2 + (maxH - h)).toFixed(1));
    fill.style.fill = _batteryColor(p);
    fill.style.transition = "fill 0.4s linear, height 0.4s linear, y 0.4s linear";
  }
  if (vText) vText.textContent = (12.0 + (p / 100) * 1.0).toFixed(1) + "V"; // simple fake voltage
  if (pctText) pctText.textContent = `${Math.round(p)}%`;
}

function _batteryColor(pct) {
  // interpolate red->yellow->green using smoothstep
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const t = clamp(pct / 100);
  // smoothstep for less abrupt transitions
  const s = t * t * (3 - 2 * t);
  // red (255,74,74) at 0, yellow (255,210,74) at 0.5, green (56,210,106) at 1
  let r, g, b;
  if (s < 0.5) {
    const u = s / 0.5;
    r = 255;
    g = 74 + (210 - 74) * u;
    b = 74;
  } else {
    const u = (s - 0.5) / 0.5;
    r = 255 - (255 - 56) * u;
    g = 210; // stays constant from midpoint
    b = 74 + (106 - 74) * u;
  }
  return `rgb(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`;
}

function _applyStatusIndicators(moduleId, powerState, linkState) {
  const info = MODULE_SVGS.get(moduleId);
  if (!info || !info.svgRoot) return;
  _setStatusLed(info.svgRoot, ["status_pwr", "status_pwrA"], powerState || "off");
  _setStatusLed(info.svgRoot, ["status_link", "status_pwrB"], linkState || "off");
}

function _powerFromSense(mask) {
  const s1 = (mask & 0x01) !== 0;
  const s2 = (mask & 0x02) !== 0;
  if (s1 && s2) return "green";
  if (s1 || s2) return "yellow";
  return "off";
}

async function _refreshModuleStatus(m) {
  const mt = String(m.type || "").toLowerCase();
  let power = m.present ? "green" : "off";
  let link = m.present ? "green" : "off";

  if (["di", "do", "aio"].includes(mt)) {
    power = "off";
    link = "off";
    try {
      const res = await fetch("/api/gui/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module_id: m.id, action: "read" }),
      });
      const data = await res.json();
      if (res.ok && data && data.ok) {
        link = data.comms_led || (data.comms_ok ? "green" : "off");
        const sm =
          typeof data.sense_mask === "number"
            ? data.sense_mask
            : typeof data.power?.sense_mask === "number"
            ? data.power.sense_mask
            : null;
        if (sm !== null) power = _powerFromSense(sm);
        else if (data.power && data.power.power_led) power = data.power.power_led;
        else power = "green";
      }
    } catch (e) {
      // leave as off
    }
    if (power === "off" && m.present) power = "green";
    if (link === "off" && m.present) link = "green";
  } else if (["rs485", "ext", "i2c"].includes(mt)) {
    power = m.present ? "green" : "off";
    link = m.present ? "green" : "off";
  }

  _applyStatusIndicators(m.id, power, link);
}

async function runTestLoop() {
  TEST_RUNNING = true;
  _setTestBtn(true);
  _allLedOff();

  while (TEST_RUNNING) {
    _setAllIndicators(true);
    // swing battery level through full range smoothly
    _TEST_BAT_PCT += _TEST_BAT_PCT_DIR;
    if (_TEST_BAT_PCT >= 100) { _TEST_BAT_PCT = 100; _TEST_BAT_PCT_DIR = -1; }
    if (_TEST_BAT_PCT <= 5) { _TEST_BAT_PCT = 5; _TEST_BAT_PCT_DIR = 1; }
    _TEST_PWR_ALT = !_TEST_PWR_ALT;
    _TEST_LINK_ALT = !_TEST_LINK_ALT;
    await _sleep(600);
    _setAllIndicators(false);
    await _sleep(200);
  }

  _allLedOff();
  _setTestBtn(false);
}

async function _injectHeadTestError(enable) {
  try {
    const resp = await fetch("/api/module_errors/test_toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enable: !!enable,
      }),
    });
    if (!resp.ok) {
      // fallback for older servers
      await fetch("/api/module_errors/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          module_num: 1,
          error: enable ? "Test-induced error" : "",
        }),
      });
    }
    // tiny delay to let server persist before UI refresh
    await _sleep(150);
  } catch (e) {
    /* ignore: endpoint only active in debug/allow mode */
  }
}

async function toggleTest() {
  if (TEST_RUNNING) {
    TEST_RUNNING = false;
    _setTestBtn(false);
    _allLedOff();
    await _injectHeadTestError(false);
    if (typeof _refreshHeadStatusOnce === "function") {
      _refreshHeadStatusOnce();
    }
    return;
  }
  // New behavior: use Test to trigger head-module error without running
  // the indicator flash loop.
  TEST_RUNNING = true;
  _setTestBtn(true);
  await _injectHeadTestError(true);
  // Also refresh head status so the red slot appears promptly.
  if (typeof _refreshHeadStatusOnce === "function") {
    _refreshHeadStatusOnce();
  }
}
window.toggleTest = toggleTest;

async function _saveModuleNum(moduleId, numVal) {
  const resp = await fetch("/modules/set_number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: moduleId, module_num: numVal }),
  });
  const data = await resp.json();
  return { ok: resp.ok && data.ok, error: data.error };
}

function _applyDipsFromAddress(form, baseAddr, addrHex) {
  if (!form) return;
  const addrSpan = form.querySelector("#address_value");
  const addr = parseInt(String(addrHex || "0x00"), 16);
  if (addrSpan) addrSpan.textContent = addrHex || "0x00";
  const offset = Math.max(0, addr - baseAddr) & 0x07;
  for (let i = 1; i <= 3; i++) {
    const bit = (offset >> (i - 1)) & 1;
    const inp = form.querySelector(`#dip${i}`);
    const slider = form.querySelector(`#dip${i}_slider`);
    const state = form.querySelector(`#dip${i}_val`);
    if (inp) inp.value = String(bit);
    if (slider) {
      slider.classList.toggle("dipswitch-on", bit === 1);
      slider.classList.toggle("dipswitch-off", bit === 0);
    }
    if (state) state.textContent = bit ? "ON" : "OFF";
  }
}

function _addressFromDips(form, baseAddr, format = "hex") {
  const d1 = Number(form.querySelector("#dip1")?.value || 0);
  const d2 = Number(form.querySelector("#dip2")?.value || 0);
  const d3 = Number(form.querySelector("#dip3")?.value || 0);
  const addrInt = baseAddr + d1 + d2 * 2 + d3 * 4;
  if (format === "dec") return String(addrInt);
  return "0x" + addrInt.toString(16).toUpperCase().padStart(2, "0");
}

function _wireDipSwitches(form, baseAddr, opts = {}) {
  if (!form) return { getAddr: () => null };
  const addrSpan = opts.addrSpan || form.querySelector("#address_value");
  const format = opts.format || "hex";
  let current = addrSpan ? addrSpan.textContent : null;
  const refresh = () => {
    const addrStr = _addressFromDips(form, baseAddr, format);
    current = addrStr;
    if (addrSpan) addrSpan.textContent = addrStr;
    if (typeof opts.onChange === "function") opts.onChange(addrStr);
  };
  for (let i = 1; i <= 3; i++) {
    const slider = form.querySelector(`#dip${i}_slider`);
    if (slider) {
      slider.onclick = () => {
        toggleDip(i);
        refresh();
      };
    }
  }
  refresh();
  return { getAddr: () => current };
}

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

  // Preload label sets for all modules so we can show channel names on card faces.
  const labelsMap = {};
  await Promise.all((data || []).map(async (m) => {
    try {
      const lr = await fetch(`/labels/${encodeURIComponent(m.id)}`);
      const lj = await lr.json();
      if (lr.ok && lj.ok && lj.labels) labelsMap[m.id] = lj.labels;
    } catch (e) { /* ignore label load errors */ }
  }));

  const displayLabel = (raw, chNum) => {
    const def = `CH${chNum}`;
    const txt = (raw || "").trim();
    if (!txt) return "--";
    if (txt.toUpperCase() === def.toUpperCase()) return "--";
    return txt;
  };

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
  let expansionCfg = null;

  for (const m of orderedModules) {
    const card = document.createElement("div");
    card.className = "module-card";

    const header = document.createElement("div");
    header.className = "module-header";

    const left = document.createElement("div");

    const fallbackTitle = (String(m.type || "").toLowerCase() === "genmon") ? "GENERATOR" : `${String(m.type || "").toUpperCase()} MODULE`;
    const displayName =
      (m.name && String(m.name).trim().length > 0)
        ? String(m.name).trim()
        : fallbackTitle;

    // Attach labels for downstream rendering convenience
    m.labels = labelsMap[m.id] || {};

    left.innerHTML = `
      <div class="module-title">${displayName}</div>
      <div class="module-sub">${String(m.type || "").toUpperCase()} • ${m.address}</div>
    `;


        const gear = document.createElement("button");
        gear.className = "icon-btn";
        gear.title = "Settings";
        gear.textContent = "⚙️";
        gear.onclick = () => showIoChannelPopup({
          module_id: m.id,
          type: m.type && m.type.toLowerCase(),
          name: m.name || `${String(m.type || '').toUpperCase()} MODULE`,
          address: m.address,
          status: m.status || undefined,
          module_num: m.module_num
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
      let fetchType = svgType;
      if (svgType === "ext") fetchType = "i2c";
      if (svgType === "rs485") fetchType = "rs485";
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

        // Populate expander labels from expansion_config (types/addresses)
        if (svgType === "ext" || svgType === "i2c") {
          try {
            if (!expansionCfg) {
              const cfgRes = await fetch("/api/expansion_config");
              const cfgData = await cfgRes.json();
              if (cfgRes.ok && cfgData && cfgData.ok) expansionCfg = cfgData.exp;
            }
            const chans = (expansionCfg && expansionCfg.channels) || [];
            for (let i = 0; i < Math.min(8, chans.length); i++) {
              const chNum = i + 1;
              const tEl = svgRoot.querySelector(`#ch${String(chNum).padStart(2, "0")}_type`);
              const aEl = svgRoot.querySelector(`#ch${String(chNum).padStart(2, "0")}_addr`);
              const chName = chans[i].name || m.labels.channels?.[String(chNum)] || `CH${chNum}`;
              const text = displayLabel(chName, chNum) || (chans[i].type || "--").toUpperCase();
              if (tEl) tEl.textContent = text;
              if (aEl) aEl.textContent = (chans[i].address_hex || "0x00").toUpperCase();
            }
          } catch (e) {
            // ignore
          }
        }

        // RS485: set branch name in SVG
        if (svgType === "rs485") {
          const nameEl = svgRoot.querySelector("#rs485_name");
          if (nameEl && m.name) nameEl.textContent = m.name;
          const chLabels = (m.labels && m.labels.channels) || labelsMap[m.id]?.channels || {};
          for (let i = 1; i <= 4; i++) {
            const tEl = svgRoot.querySelector(`#ch${String(i).padStart(2, "0")}_type`);
            const label = displayLabel(chLabels[String(i)], i);
            if (tEl) tEl.textContent = label;
          }
        }

        // Generator: add load-more link click to detail popup
        if (svgType === "genmon") {
          const more = svgRoot.querySelector("#genmon_load_more");
          if (more) {
            more.style.cursor = "pointer";
            more.onclick = (e) => {
              e.stopPropagation();
              showGenmonDetailPopup(m.id);
            };
          }
        }

        // Add onclick to IO bubbles (circles/dots) for popup
        const mt = String(m.type).toLowerCase();
        if (["di", "do", "aio", "ext", "i2c"].includes(mt)) {
        const channelGroups = svgRoot.querySelectorAll("g[id^='ch'], circle[id^='ch']");
        channelGroups.forEach((g, idx) => {
          // Support both circle as group child or the circle itself
          const circle = g.tagName.toLowerCase() === 'circle' ? g : g.querySelector("circle");
          if (!circle) return;

            const idStr = (circle.id || g.id || "").toLowerCase();
            let chNum = idx + 1;
            const match = idStr.match(/ch(\d+)/);
            if (match && match[1]) {
              chNum = parseInt(match[1], 10);
              if (Number.isNaN(chNum) || chNum < 1) chNum = idx + 1;
            }

            circle.style.cursor = "pointer";
            circle.onclick = (e) => {
              e.stopPropagation();
              let chName = `Channel ${chNum}`;
              if (m.labels && m.labels.channels && m.labels.channels[String(chNum)]) {
                chName = m.labels.channels[String(chNum)];
              }
              const status = circle.classList.contains("led-on") ? "ON" : "OFF";
              showIoChannelPopup({
                name: chName,
                status,
                type: m.type.toLowerCase(),
                channel: chNum,
                module_id: m.id,
                address: m.address
              });
            };
          });
        }

        await _refreshModuleStatus(m);
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
  const name = $("add_name")?.value || "";
  // Calculate address from module type and DIP switches
  const dip1 = Number(document.getElementById("dip1")?.value || 0);
  const dip2 = Number(document.getElementById("dip2")?.value || 0);
  const dip3 = Number(document.getElementById("dip3")?.value || 0);
  let base = 0x20;
  if (type === "do") base = 0x30;
  else if (type === "aio") base = 0x40;
  else if (type === "rs485") base = 0x50;
  else if (type === "ext") base = 0x60; // I2C Module
  else if (type === "genmon") base = 0x01; // Generac default RS485 address base
  const addrNum = base + dip1*1 + dip2*2 + dip3*4;
  const addr = type === "genmon"
    ? `${addrNum}`
    : "0x" + addrNum.toString(16).toUpperCase();
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

// DIP switch UI logic (always visible)
document.addEventListener("DOMContentLoaded", function() {
  const addrInput = document.getElementById("add_addr");
  const dip1 = document.getElementById("dip1");
  const dip2 = document.getElementById("dip2");
  const dip3 = document.getElementById("dip3");
  const dip1Val = document.getElementById("dip1_val");
  const dip2Val = document.getElementById("dip2_val");
  const dip3Val = document.getElementById("dip3_val");

  function updateAddrFromDips() {
    if (!dip1 || !dip2 || !dip3 || !addrInput) return;
    const d1 = Number(dip1.value);
    const d2 = Number(dip2.value);
    const d3 = Number(dip3.value);
    const base = 0x10;
    const dipAddr = base + (d1 << 2) + (d2 << 1) + d3;
    addrInput.value = "0x" + dipAddr.toString(16).toUpperCase();
    if (dip1Val) dip1Val.textContent = d1 ? "ON" : "OFF";
    if (dip2Val) dip2Val.textContent = d2 ? "ON" : "OFF";
    if (dip3Val) dip3Val.textContent = d3 ? "ON" : "OFF";
  }

  if (dip1) dip1.addEventListener("input", updateAddrFromDips);
  if (dip2) dip2.addEventListener("input", updateAddrFromDips);
  if (dip3) dip3.addEventListener("input", updateAddrFromDips);
  updateAddrFromDips();
});

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
    name: module.name || "",
    module_num: module.module_num || "",
  };

  $("modal_title").textContent = `Settings • ${String(module.type || "").toUpperCase()}`;
  $("modal_sub").textContent = `${module.address} • ${module.id}`;

  $("modal_module_name").value = module.name || "";
  $("modal_address_display").textContent = module.address || "0x00";
  const moduleNumSel = $("modal_module_num");
  if (moduleNumSel) moduleNumSel.value = module.module_num ? String(module.module_num) : "";

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
    inp.placeholder = `CH${i}`;
    inp.value = `CH${i}`;
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
  const moduleNumSel = $("modal_module_num");
  const moduleNumVal = moduleNumSel ? moduleNumSel.value : "";

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

  // Save module number (unique 1-10 or cleared)
  if (MODAL_CTX.id) {
    const rnum = await fetch("/modules/set_number", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: MODAL_CTX.id, module_num: moduleNumVal }),
    });
    const dnum = await rnum.json();
    if (!dnum.ok) {
      if (err) {
        err.textContent = "Error saving module ID: " + dnum.error;
        err.style.display = "block";
      }
      return;
    }
  }

  const channels = {};
  for (let i = 1; i <= 16; i++) {
    const val = $(`ch_name_${i}`).value || `CH${i}`;
    channels[String(i)] = val;
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
        <div class="module-title">I2C MODULE</div>
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
  ensureRemoveButton(popup, null);
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
      <button type="button" id="remove_expansion_card_btn" style="background:#f44336;color:#fff;margin-bottom:10px;">Remove This Card</button>
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
  html += `<button type="submit" class="global-save">Save</button></form>`;
  controls.innerHTML = html;

  // Handle remove card button
  const removeBtn = controls.querySelector("#remove_expansion_card_btn");
  if (removeBtn) {
    removeBtn.onclick = async function() {
      if (!confirm("Are you sure you want to remove this expansion card? This cannot be undone.")) return;
      // Remove expansion card config by clearing the file
      const res = await fetch("/api/expansion_config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", address_hex: "", channels: [] })
      });
      const data = await res.json();
      if (data.ok) {
        alert("Expansion card removed.");
        hideIoChannelPopup();
        // Optionally reload UI
        if (typeof loadModules === 'function') loadModules();
      } else {
        alert("Failed to remove card: " + (data.error || "Unknown error"));
      }
    };
  }

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
      if (typeof loadModules === 'function') loadModules();
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

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
  // Address mapping: DIP1*1 + DIP2*2 + DIP3*4
  const addrNum = base + dip1*1 + dip2*2 + dip3*4;
  const addr = "0x" + addrNum.toString(16).toUpperCase();
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

  // Always add a close button (outside form so it is not a submit)
  const closeBtn = document.createElement('button');
  closeBtn.className = 'popup-close global';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = hideIoChannelPopup;
  popup.appendChild(closeBtn);

  // ---------------- DI/DO global config ----------------
  if (type === 'di' || type === 'do') {
    const nameInput = form.querySelector('input[name="module_name"]');
    const addressSpan = form.querySelector('#address_value');
    if (nameInput && ctx.name) nameInput.value = ctx.name;
    if (addressSpan && ctx.address) addressSpan.textContent = ctx.address;

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
    if (nameInput && ctx.name) nameInput.value = ctx.name;
    if (addrInput && ctx.address) addrInput.value = ctx.address;

    let saveBtn = controls.querySelector('.aio-global-save');
    if (!saveBtn) {
      saveBtn = document.createElement('button');
      saveBtn.className = 'aio-global-save';
      saveBtn.textContent = 'Save';
      controls.appendChild(saveBtn);
    }

    // Add remove button for AIO
    if (ctx.module_id) {
      let removeBtn = controls.querySelector('.popup-remove');
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.className = 'popup-remove danger';
        removeBtn.textContent = 'Remove This Card';
        removeBtn.style.marginTop = '16px';
        removeBtn.onclick = async function() {
          if (!confirm('Are you sure you want to remove this card/module? This cannot be undone.')) return;
          const res = await fetch('/modules/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.module_id }),
          });
          const data = await res.json();
          if (data.ok) {
            alert('Module removed.');
            hideIoChannelPopup();
            if (typeof loadModules === 'function') loadModules();
          } else {
            alert('Failed to remove module: ' + (data.error || 'Unknown error'));
          }
        };
        controls.appendChild(removeBtn);
      }
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

    let saveBtn = controls.querySelector('.ext-global-save');
    if (!saveBtn) {
      saveBtn = document.createElement('button');
      saveBtn.className = 'ext-global-save';
      saveBtn.textContent = 'Save';
      controls.appendChild(saveBtn);
    }

    // Add remove button for I2C Module
    if (ctx.module_id) {
      let removeBtn = controls.querySelector('.popup-remove');
      if (!removeBtn) {
        removeBtn = document.createElement('button');
        removeBtn.className = 'popup-remove danger';
        removeBtn.textContent = 'Remove This I2C Module';
        removeBtn.style.marginTop = '16px';
        removeBtn.onclick = async function() {
          if (!confirm('Are you sure you want to remove this card/module? This cannot be undone.')) return;
          const res = await fetch('/modules/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ctx.module_id }),
          });
          const data = await res.json();
          if (data.ok) {
            alert('Module removed.');
            hideIoChannelPopup();
            if (typeof loadModules === 'function') loadModules();
          } else {
            alert('Failed to remove module: ' + (data.error || 'Unknown error'));
          }
        };
        controls.appendChild(removeBtn);
      }
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
      }
    };

    loadExtConfig();
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

  // Preload label sets for all modules so we can show channel names on card faces.
  const labelsMap = {};
  await Promise.all((data || []).map(async (m) => {
    try {
      const lr = await fetch(`/labels/${encodeURIComponent(m.id)}`);
      const lj = await lr.json();
      if (lr.ok && lj.ok && lj.labels) labelsMap[m.id] = lj.labels;
    } catch (e) { /* ignore label load errors */ }
  }));

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

    const displayName =
      (m.name && String(m.name).trim().length > 0)
        ? String(m.name).trim()
        : `${String(m.type || "").toUpperCase()} MODULE`;

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
        if (svgType === "ext") {
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
              const chName = (chans[i].name || m.labels.channels?.[String(chNum)] || "").trim();
              if (tEl) tEl.textContent = chName || (chans[i].type || "--").toUpperCase();
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
            const label = (chLabels[String(i)] || "").trim();
            if (tEl && label) tEl.textContent = label;
          }
        }

        // Add onclick to IO bubbles (circles/dots) for popup
        const mt = String(m.type).toLowerCase();
        if (["di", "do", "aio", "ext", "rs485"].includes(mt)) {
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
  const addrNum = base + dip1*1 + dip2*2 + dip3*4;
  const addr = "0x" + addrNum.toString(16).toUpperCase();
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
  html += `<button type="submit">Save</button></form>`;
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

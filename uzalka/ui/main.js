const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let snapshot = [];
let paused = null;

const $ = (id) => document.getElementById(id);

const EYE_OPEN = `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 2c3.27 0 6.06 2.03 7.72 5.51a1.13 1.13 0 0 1 0 .98C14.06 11.97 11.27 14 8 14S1.94 11.97.28 8.49a1.13 1.13 0 0 1 0-.98C1.94 4.03 4.73 2 8 2Zm0 1.5C5.4 3.5 3.12 5.09 1.66 8 3.12 10.91 5.4 12.5 8 12.5s4.88-1.59 6.34-4.5C12.88 5.09 10.6 3.5 8 3.5Zm0 1.75a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Zm0 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/></svg>`;
const EYE_CLOSED = `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 12.74 9.792 13 8 13 4.73 13 1.94 10.97.28 7.49a1.13 1.13 0 0 1 0-.98c.635-1.33 1.425-2.45 2.34-3.316L.31 3.357A.75.75 0 0 1 .143 2.31Zm3.71 2.7C3.02 5.77 2.29 6.77 1.66 8c1.46 2.91 3.74 4.5 6.34 4.5 1.25 0 2.42-.37 3.47-1.05l-1.51-1.09a2.75 2.75 0 0 1-3.79-2.74L3.852 5.01ZM8 3c3.27 0 6.06 2.03 7.72 5.51.15.31.15.67 0 .98-.34.71-.73 1.36-1.15 1.95l-1.21-.88c.31-.44.6-.93.86-1.46C12.76 6.19 10.48 4.6 7.88 4.6c-.5 0-.98.06-1.45.17L5.15 3.85C6.05 3.3 7 3 8 3Z"/></svg>`;
const TRASH = `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>`;

const ICON_ANTHROPIC = `<svg viewBox="0 0 24 24"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>`;
const ICON_OPENAI = `<svg viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>`;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sevColor(p) {
  if (p >= 90) return "var(--red)";
  if (p >= 70) return "var(--amber)";
  return "var(--green)";
}

function parseReset(v) {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v * 1000);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function resetText(v) {
  const d = parseReset(v);
  if (!d) return "";
  const ms = d - Date.now();
  if (ms <= 0) return "resets now";
  const min = Math.round(ms / 60000);
  let rel;
  if (min < 60) rel = `${min}m`;
  else if (min < 48 * 60) rel = `${Math.floor(min / 60)}h ${min % 60}m`;
  else rel = `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
  return `resets in ${rel}`;
}

// ---- custom tooltip ----

const tip = document.createElement("div");
tip.className = "tooltip";
document.body.appendChild(tip);
let tipTimer = null;

document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[data-ts]");
  if (!t) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    const d = new Date(Number(t.dataset.ts));
    const day = d.toLocaleDateString("en-US", { weekday: "long" });
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    tip.innerHTML = `<div class="tip-day">${esc(day)}</div><div class="tip-sub">${esc(date)} · ${esc(time)}</div>`;
    tip.classList.add("show");
    const r = t.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(6, Math.min(x, window.innerWidth - tw - 6));
    let y = r.top - th - 7;
    if (y < 6) y = r.bottom + 7;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }, 80);
});

document.addEventListener("mouseout", (e) => {
  if (e.target.closest && e.target.closest("[data-ts]")) {
    clearTimeout(tipTimer);
    tip.classList.remove("show");
  }
});

function brandIcon(kind) {
  return kind === "claude"
    ? `<span class="brand-icon brand-anthropic" title="Claude">${ICON_ANTHROPIC}</span>`
    : `<span class="brand-icon brand-openai" title="Codex">${ICON_OPENAI}</span>`;
}

function ring(p) {
  const c = sevColor(p);
  const deg = Math.max(0, Math.min(100, p)) * 3.6;
  return `<span class="ring" style="background:
    radial-gradient(closest-side, var(--card) 54%, transparent 55% 100%),
    conic-gradient(${c} ${deg}deg, var(--track) 0)"></span>`;
}

// ---- accounts view ----

function agoText(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

function renderAccounts() {
  const root = $("view-accounts");
  const visible = snapshot.filter((a) => !a.hidden && !a.duplicate_of);
  const banner = paused ? `<div class="paused-banner">${esc(paused)}</div>` : "";
  if (!visible.length) {
    root.innerHTML = banner + `<div class="empty-state">No accounts found.<br>Add a config path in settings.</div>`;
    return;
  }
  root.innerHTML = banner + visible
    .map((a) => {
      let body;
      if (a.error && !a.windows.length) {
        const isPause = paused && a.error === paused;
        body = `<div class="card-error"${isPause ? ' style="color:var(--muted)"' : ""}>${esc(isPause ? "refresh paused" : a.error)}</div>`;
      } else if (!a.windows.length) {
        body = `<div class="card-error" style="color:var(--muted)">no limit data</div>`;
      } else {
        body = a.windows
          .map((w) => {
            const p = Math.max(0, Math.min(100, w.percent));
            const rt = resetText(w.resets_at);
            const rd = parseReset(w.resets_at);
            return `
              <div class="limit-line">
                ${ring(p)}
                <span class="pct" style="color:${sevColor(p)}">${Math.round(p)}%</span>
                <span class="lbl">${esc(w.label)}</span>
                ${rt ? `<span class="reset" ${rd ? `data-ts="${+rd}"` : ""}>· ${esc(rt)}</span>` : ""}
              </div>`;
          })
          .join("");
        if (a.credits) {
          body += `<div class="credits-row">Credits: $${esc(a.credits)}</div>`;
        }
        if (a.stale) {
          const ago = a.updated_ms ? agoText(a.updated_ms) : "";
          body += `<div class="stale-row" title="${esc(a.error || "")}">stale · updated ${ago}</div>`;
        }
      }
      return `
        <div class="card">
          <div class="card-head">
            ${brandIcon(a.kind)}
            <span class="acc-name">${esc(a.name)}</span>
            <span class="acc-email" title="${esc(a.email || "")}">${esc(a.email || "")}</span>
            ${a.plan ? `<span class="plan-badge">${esc(a.plan)}</span>` : ""}
            <button class="icon-btn" title="Hide" data-hide="${esc(a.id)}">${EYE_OPEN}</button>
          </div>
          ${body}
        </div>`;
    })
    .join("");

  root.querySelectorAll("[data-hide]").forEach((btn) => {
    btn.addEventListener("click", () => invoke("set_hidden", { id: btn.dataset.hide, hidden: true }));
  });
}

// ---- settings view ----

function renderSettings() {
  const root = $("settings-list");
  if (!snapshot.length) {
    root.innerHTML = `<div class="hint">No accounts found.</div>`;
    return;
  }
  root.innerHTML = snapshot
    .map(
      (a) => `
      <div class="settings-item ${a.hidden ? "is-hidden" : ""}">
        ${brandIcon(a.kind)}
        <span class="acc-name">${esc(a.name)}</span>
        ${a.duplicate_of ? `<span class="plan-badge" title="Same account as ${esc(a.duplicate_of)}">dup of ${esc(a.duplicate_of)}</span>` : ""}
        <span class="path" title="${esc(a.path)}">${esc(a.path)}</span>
        <button class="icon-btn" title="${a.hidden ? "Show" : "Hide"}" data-toggle="${esc(a.id)}" data-hidden="${a.hidden}">
          ${a.hidden ? EYE_CLOSED : EYE_OPEN}
        </button>
        ${a.custom ? `<button class="icon-btn" title="Remove" data-remove="${esc(a.path)}">${TRASH}</button>` : ""}
      </div>`
    )
    .join("");

  root.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () =>
      invoke("set_hidden", { id: btn.dataset.toggle, hidden: btn.dataset.hidden !== "true" })
    );
  });
  root.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => invoke("remove_custom_path", { path: btn.dataset.remove }));
  });
}

function render() {
  renderAccounts();
  renderSettings();
}

// ---- wiring ----

function showSettingsView(show) {
  $("view-settings").hidden = !show;
  $("view-accounts").hidden = show;
  $("brand-home").hidden = show;
  $("brand-settings").hidden = !show;
  $("btn-settings").hidden = show;
  $("btn-refresh").hidden = show;
}

$("btn-settings").addEventListener("click", () => {
  showSettingsView(true);
  renderHub();
});
$("btn-back").addEventListener("click", () => showSettingsView(false));

// drag the window by its header — only after real movement, so plain
// clicks on the title don't trigger a drag (which steals focus and
// hides the popup)
let dragStart = null;
$("header").addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("button, input")) return;
  dragStart = { x: e.screenX, y: e.screenY };
});
$("header").addEventListener("mousemove", (e) => {
  if (!dragStart || e.buttons !== 1) return;
  if (Math.abs(e.screenX - dragStart.x) + Math.abs(e.screenY - dragStart.y) > 4) {
    dragStart = null;
    invoke("begin_drag");
  }
});
window.addEventListener("mouseup", () => (dragStart = null));

$("btn-refresh").addEventListener("click", async () => {
  $("btn-refresh").classList.add("spinning");
  try {
    await invoke("refresh_now");
  } finally {
    $("btn-refresh").classList.remove("spinning");
  }
});

$("btn-add").addEventListener("click", async () => {
  const input = $("input-path");
  const err = $("add-error");
  const path = input.value.trim();
  if (!path) return;
  err.hidden = true;
  $("btn-add").disabled = true;
  try {
    await invoke("add_custom_path", { path });
    input.value = "";
  } catch (e) {
    err.textContent = String(e);
    err.hidden = false;
  } finally {
    $("btn-add").disabled = false;
  }
});

$("input-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-add").click();
});

async function renderAutostart() {
  const on = await invoke("get_autostart");
  const b = $("btn-autostart");
  b.textContent = on ? "Remove from startup" : "Add to startup";
  b.dataset.on = on;
}

$("btn-autostart").addEventListener("click", async () => {
  const b = $("btn-autostart");
  b.disabled = true;
  try {
    await invoke("set_autostart", { enabled: b.dataset.on !== "true" });
  } finally {
    b.disabled = false;
  }
  renderAutostart();
});

renderAutostart();

// ---- T3 hub ----

async function renderHub() {
  const info = await invoke("get_hub_info");
  $("hub-url").value = info.url;
  $("hub-key").value = info.key;
  let status;
  if (!info.enabled) status = "Disabled in config.json.";
  else if (info.error) status = `Not running: ${info.error}`;
  else if (info.last_request_ms) status = `Last request from T3 ${agoText(info.last_request_ms)} (${info.requests} total${info.unauthorized ? `, ${info.unauthorized} rejected` : ""}).`;
  else status = "Running. No requests from T3 yet.";
  $("hub-status").textContent = status;
}

document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const input = $(btn.dataset.copy);
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      document.execCommand("copy");
    }
    const label = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = label), 1200);
  });
});

// refresh relative times every 30s
setInterval(() => {
  if (snapshot.length) render();
}, 30000);

function applySnapshot(s) {
  snapshot = s.accounts || [];
  paused = s.paused || null;
  render();
}

listen("snapshot", (event) => applySnapshot(event.payload));
invoke("get_snapshot").then(applySnapshot);

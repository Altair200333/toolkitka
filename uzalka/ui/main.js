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
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

function agoText(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

const clampPct = (p) => Math.max(0, Math.min(100, Number(p) || 0));

// ---- colors ----

// A ring keeps the color of its limit type while usage is fine and turns
// warm near the limit (same 70 / 90 thresholds as the tray icon).
const TYPE_GRAD = {
  session: ["#6b67ff", "#a98bff"],
  weekly: ["#2f8cff", "#5fd4f4"],
  model: ["#b66dff", "#ff7cc8"],
  other: ["#1fbf9a", "#7be3c4"],
};
const SEV_GRAD = { warn: ["#f08a24", "#ffc85c"], crit: ["#ff4d5e", "#ff8a4c"] };
const SEV_TEXT = { ok: "var(--text)", warn: "var(--amber)", crit: "var(--red)" };

function sev(p) {
  return p >= 90 ? "crit" : p >= 70 ? "warn" : "ok";
}

function windowType(w) {
  const label = w.label || "";
  if (/^session/i.test(label)) return "session";
  if (label.includes("·")) return "model";
  if (/^weekly/i.test(label)) return "weekly";
  return "other";
}

function gradFor(w, p) {
  const s = sev(p);
  return s === "ok" ? TYPE_GRAD[windowType(w)] : SEV_GRAD[s];
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
    if (!t.isConnected) return; // replaced by a new snapshot meanwhile
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
  if (e.target.closest && e.target.closest("[data-ts]")) hideTip();
});

function hideTip() {
  clearTimeout(tipTimer);
  tip.classList.remove("show");
}

function brandIcon(kind) {
  return kind === "claude"
    ? `<span class="brand-icon brand-anthropic" title="Claude">${ICON_ANTHROPIC}</span>`
    : `<span class="brand-icon brand-openai" title="Codex">${ICON_OPENAI}</span>`;
}

// ---- rings ----

const RING = 68;
let gradId = 0;

// items: [{ key, p, g: [from, to] }], outer ring first
function ringsSvg(items) {
  const n = Math.max(1, items.length);
  const gap = n > 3 ? 2 : 2.5;
  const room = RING / 2 - 1 - 8; // keep a hole for the logo
  const stroke = Math.min(8, (room - (n - 1) * gap) / n);
  const c = RING / 2;
  let r = c - stroke / 2 - 1;
  let defs = "";
  let body = "";
  if (!items.length) {
    body = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity=".07" stroke-width="${stroke}"/>`;
  }
  items.forEach((it, i) => {
    const C = 2 * Math.PI * r;
    const id = `rg${gradId++}`;
    defs += `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${it.g[0]}"/><stop offset="1" stop-color="${it.g[1]}"/></linearGradient>`;
    body += `<g class="rg" data-i="${i}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${it.g[0]}" stroke-opacity=".16" stroke-width="${stroke}"/>
      <circle class="arc" data-key="${esc(it.key)}" data-c="${C}" data-p="${it.p}" cx="${c}" cy="${c}" r="${r}" fill="none"
        stroke="url(#${id})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${C} ${C}"
        transform="rotate(-90 ${c} ${c})" style="stroke-dashoffset:${C}px;filter:drop-shadow(0 0 3px ${it.g[1]}88)"/>
    </g>`;
    r -= stroke + gap;
  });
  return `<svg width="${RING}" height="${RING}" viewBox="0 0 ${RING} ${RING}" style="--sw-focus:${(stroke + 1.5).toFixed(2)}px"><defs>${defs}</defs>${body}</svg>`;
}

// ---- accounts view ----

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let popupVisible = false;
let entering = false;
let enterTimer = null;
const shownPct = new Map(); // pct key -> number currently on screen
let tweenFrame = 0;

function cardHtml(a, index) {
  const wins = a.windows || [];
  const items = wins.map((w) => {
    const p = clampPct(w.percent);
    return { key: `${a.id}|${w.label}`, p, g: gradFor(w, p), w };
  });
  const worst = items.reduce((m, it) => Math.max(m, it.p), 0);

  let body;
  if (a.error && !wins.length) {
    const isPause = paused && a.error === paused;
    body = `<div class="card-note${isPause ? "" : " error"}">${esc(isPause ? "refresh paused" : a.error)}</div>`;
  } else if (!wins.length) {
    body = `<div class="card-note">no limit data</div>`;
  } else {
    body = items
      .map((it, i) => {
        const rd = parseReset(it.w.resets_at);
        return `<div class="row" data-i="${i}">
          <span class="dot" style="background:linear-gradient(135deg,${it.g[0]},${it.g[1]})"></span>
          <span class="lbl">${esc(it.w.label)}</span>
          <span class="pct num" data-key="${esc(it.key)}" data-to="${Math.round(it.p)}" style="color:${SEV_TEXT[sev(it.p)]}">${Math.round(it.p)}%</span>
          <span class="reset num" ${rd ? `data-ts="${+rd}"` : ""}>${esc(resetText(it.w.resets_at))}</span>
        </div>`;
      })
      .join("");
  }

  let chip = "";
  if (a.stale && wins.length) {
    const ago = a.updated_ms ? agoText(a.updated_ms) : "";
    chip = `<span class="chip stale" title="${esc(a.error || "")}">stale · ${esc(ago)}</span>`;
  } else if (a.credits) {
    chip = `<span class="chip credits">Credits $${esc(a.credits)}</span>`;
  }
  if (a.credits && a.stale && wins.length) body += `<div class="credits-line">Credits: $${esc(a.credits)}</div>`;

  return `
    <div class="card${sev(worst) === "crit" ? " crit" : ""}${entering && !enterRender ? " no-enter" : ""}" style="--i:${index}" data-id="${esc(a.id)}">
      <div class="rings">${ringsSvg(items)}<span class="logo-mark">${a.kind === "claude" ? ICON_ANTHROPIC : ICON_OPENAI}</span></div>
      <div class="main">
        <div class="top">
          <span class="acc-name">${esc(a.name)}</span>
          ${a.plan ? `<span class="plan-badge">${esc(a.plan)}</span>` : ""}
          <span class="spacer"></span>
          <button class="icon-btn" title="Hide" data-hide="${esc(a.id)}">${EYE_OPEN}</button>
        </div>
        <div class="sub-line">
          <span class="acc-email" title="${esc(a.email || "")}">${esc(a.email || "")}</span>
          ${chip}
        </div>
        ${body}
      </div>
    </div>`;
}

// what the rings show right now (mid-animation included), so a new render
// continues from there instead of jumping
function arcsOnScreen(root) {
  const m = new Map();
  root.querySelectorAll(".arc").forEach((el) => {
    const off = parseFloat(getComputedStyle(el).strokeDashoffset);
    const C = Number(el.dataset.c);
    if (isFinite(off) && C > 0) m.set(el.dataset.key, 1 - off / C);
  });
  return m;
}

let enterRender = false;

function renderAccounts({ enter = false } = {}) {
  const root = $("view-accounts");
  const visible = snapshot.filter((a) => !a.hidden && !a.duplicate_of);
  const banner = paused ? `<div class="paused-banner">${esc(paused)}</div>` : "";
  const animate = popupVisible && !reducedMotion.matches;
  const from = enter ? new Map() : arcsOnScreen(root);
  hideTip();
  if (!visible.length) {
    cancelAnimationFrame(tweenFrame);
    shownPct.clear();
    root.innerHTML = banner + `<div class="empty-state">No accounts found.<br>Add a config path in settings.</div>`;
    return;
  }
  enterRender = enter;
  root.innerHTML = banner + visible.map(cardHtml).join("");
  enterRender = false;

  // rings: start where they were (or empty), then let the CSS transition run
  const arcs = [...root.querySelectorAll(".arc")];
  for (const el of arcs) {
    const C = Number(el.dataset.c);
    const p = Number(el.dataset.p) / 100;
    const start = animate ? from.get(el.dataset.key) ?? 0 : p;
    el.style.transition = "none";
    el.style.strokeDashoffset = `${C * (1 - start)}px`;
    el.style.opacity = p > 0 || (animate && start > 0) ? "1" : "0";
  }
  if (animate) {
    void root.offsetWidth;
    for (const el of arcs) {
      const C = Number(el.dataset.c);
      const p = Number(el.dataset.p) / 100;
      const card = el.closest(".card");
      const ring = Number(el.closest(".rg").dataset.i);
      const delay = enter ? 140 + Number(card.style.getPropertyValue("--i")) * 45 + ring * 70 : 0;
      el.style.transition = "";
      el.style.transitionDelay = `${delay}ms, 0ms, 0ms`;
      el.style.strokeDashoffset = `${C * (1 - p)}px`;
      // a 0% ring would leave a round-cap dot behind; fade it once drawn
      if (p === 0) {
        el.addEventListener("transitionend", function done(e) {
          if (e.propertyName !== "stroke-dashoffset") return;
          el.style.opacity = "0";
          el.removeEventListener("transitionend", done);
        });
      }
    }
  }
  tweenNumbers(root, enter, animate);
}

const easeOut = (t) => 1 - Math.pow(1 - t, 4);

function tweenNumbers(root, enter, animate) {
  cancelAnimationFrame(tweenFrame);
  const jobs = [...root.querySelectorAll(".pct[data-key]")].map((el) => {
    const to = Number(el.dataset.to);
    const key = el.dataset.key;
    const from = !animate ? to : enter ? 0 : shownPct.get(key) ?? to;
    const card = el.closest(".card");
    const delay = enter ? 140 + Number(card.style.getPropertyValue("--i")) * 45 : 0;
    return { el, key, from, to, delay };
  });
  const live = new Set(jobs.map((j) => j.key));
  for (const key of shownPct.keys()) if (!live.has(key)) shownPct.delete(key);
  for (const j of jobs) {
    j.el.textContent = `${Math.round(j.from)}%`;
    shownPct.set(j.key, j.from);
  }
  if (jobs.every((j) => j.from === j.to)) return;
  const start = performance.now();
  const DURATION = 900;
  const step = (now) => {
    let running = false;
    for (const j of jobs) {
      const t = Math.min(1, Math.max(0, (now - start - j.delay) / DURATION));
      const v = j.from + (j.to - j.from) * easeOut(t);
      j.el.textContent = `${Math.round(v)}%`;
      shownPct.set(j.key, v);
      if (t < 1) running = true;
    }
    if (running) tweenFrame = requestAnimationFrame(step);
  };
  tweenFrame = requestAnimationFrame(step);
}

// ---- header ----

function headerSub() {
  const sub = $("header-sub");
  if (sub.classList.contains("busy")) return;
  const times = snapshot.filter((a) => !a.hidden && a.updated_ms).map((a) => a.updated_ms);
  sub.textContent = times.length ? `updated ${agoText(Math.max(...times))}` : "";
}

// relative times age without new data; update the text only
function tick() {
  document.querySelectorAll(".reset[data-ts]").forEach((el) => {
    el.textContent = resetText(Number(el.dataset.ts) / 1000);
  });
  headerSub();
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
  headerSub();
}

// ---- motion: hover links a row with its ring, light follows the mouse ----

let focused = null; // { card, i }

function setFocus(card, i) {
  if (focused && focused.card === card && focused.i === i) return;
  if (focused) {
    focused.card.querySelectorAll(".row.focus, .rg.focus, .rg.dim").forEach((el) => el.classList.remove("focus", "dim"));
  }
  focused = card && i != null ? { card, i } : null;
  if (!focused) return;
  card.querySelectorAll(".row").forEach((el) => el.classList.toggle("focus", el.dataset.i === i));
  card.querySelectorAll(".rg").forEach((el) => {
    el.classList.toggle("focus", el.dataset.i === i);
    el.classList.toggle("dim", el.dataset.i !== i);
  });
}

$("view-accounts").addEventListener("mouseover", (e) => {
  const card = e.target.closest(".card");
  const hit = e.target.closest(".row, .rg");
  setFocus(card, hit ? hit.dataset.i : null);
});
$("view-accounts").addEventListener("mouseleave", () => setFocus(null, null));
$("view-accounts").addEventListener("mousemove", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
});

$("view-accounts").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-hide]");
  if (!btn) return;
  const card = btn.closest(".card");
  card.classList.add("leaving");
  invoke("set_hidden", { id: btn.dataset.hide, hidden: true }).catch(() => card.classList.remove("leaving"));
});

// click ripple on every button
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest(".btn, .icon-btn");
  if (!btn || btn.disabled || reducedMotion.matches) return;
  const r = btn.getBoundingClientRect();
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.style.left = `${e.clientX - r.left}px`;
  dot.style.top = `${e.clientY - r.top}px`;
  btn.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove());
});

// ---- popup show / hide ----

let lastEnter = 0;

function enter() {
  // the Rust event and the focus fallback can both arrive for one show
  if (popupVisible && performance.now() - lastEnter < 500) return;
  lastEnter = performance.now();
  popupVisible = true;
  lastFit = 0; // the monitor or its scale may have changed since last time
  const app = $("app");
  app.classList.remove("away", "entering");
  void app.offsetWidth;
  entering = true;
  app.classList.add("entering");
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => {
    entering = false;
    app.classList.remove("entering");
    app.querySelectorAll(".no-enter").forEach((el) => el.classList.remove("no-enter"));
  }, 1300);
  if (!$("view-accounts").hidden) renderAccounts({ enter: true });
  tick();
  fitSoon();
}

function leave() {
  popupVisible = false;
  hideTip();
  setFocus(null, null);
  $("app").classList.add("away");
}

listen("popup-visibility", (e) => (e.payload ? enter() : leave()));
// the page starts hidden (class "away"); if the show event were ever lost,
// focus still brings it back
window.addEventListener("focus", () => {
  if (!popupVisible) enter();
});
// shown before this page finished loading: the event above was missed
invoke("popup_visible").then((shown) => shown && !popupVisible && enter()).catch(() => {});

// ---- window height follows the content ----

let fitTimer = null;
let lastFit = 0;

function currentView() {
  return $("view-accounts").hidden ? $("view-settings") : $("view-accounts");
}

function updateFades(view) {
  const scrollable = view.scrollHeight > view.clientHeight + 1;
  view.classList.toggle("fade-bottom", scrollable && view.scrollTop + view.clientHeight < view.scrollHeight - 2);
  view.classList.toggle("fade-top", scrollable && view.scrollTop > 2);
}

function fitWindow() {
  const view = currentView();
  const height = Math.ceil($("header").offsetHeight + view.scrollHeight + 2); // + app border
  updateFades(view);
  if (height === lastFit) return;
  lastFit = height;
  invoke("fit_height", { height }).catch(() => (lastFit = 0));
}

function fitSoon() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitWindow, 0);
}

new MutationObserver(fitSoon).observe($("app"), {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["hidden"],
});
document.fonts.ready.then(fitSoon);
// re-measure after every resize: a scrollbar that came or went changes how
// text wraps, so the first measurement may be off by a line
window.addEventListener("resize", fitSoon);
for (const id of ["view-accounts", "view-settings"]) {
  $(id).addEventListener("scroll", (e) => updateFades(e.target));
}

// ---- wiring ----

function showSettingsView(show) {
  $("view-settings").hidden = !show;
  $("view-accounts").hidden = show;
  $("brand-home").hidden = show;
  $("brand-settings").hidden = !show;
  $("btn-settings").hidden = show;
  $("btn-refresh").hidden = show;
  hideTip();
  const view = currentView();
  view.classList.remove("slide-left", "slide-right");
  if (reducedMotion.matches) return;
  void view.offsetWidth;
  view.classList.add(show ? "slide-left" : "slide-right");
}

for (const id of ["view-accounts", "view-settings"]) {
  $(id).addEventListener("animationend", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove("slide-left", "slide-right");
  });
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
  const sub = $("header-sub");
  $("btn-refresh").classList.add("spinning");
  sub.classList.add("busy");
  sub.textContent = "refreshing…";
  try {
    await invoke("refresh_now");
  } finally {
    $("btn-refresh").classList.remove("spinning");
    sub.classList.remove("busy");
    headerSub();
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

setInterval(tick, 30000);

function applySnapshot(s) {
  snapshot = s.accounts || [];
  paused = s.paused || null;
  render();
}

listen("snapshot", (event) => applySnapshot(event.payload));
invoke("get_snapshot").then(applySnapshot);

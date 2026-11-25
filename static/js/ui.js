// Composants communs (équivalent d'AdminUI) : PageHeader, aide, EmptyState, Modal, Drawer, Switch, toasts…

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const icon = (name, cls = "") => `<i data-lucide="${esc(name)}" class="${cls}"></i>`;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function paintIcons(root = document) {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 2 }, nameAttr: "data-lucide", root });
}

// ---------------------------------------------------------------- API
export class ApiError extends Error {
  constructor(status, detail) { super(typeof detail === "string" ? detail : "Erreur"); this.status = status; this.detail = detail; }
}
export async function api(path, { method = "GET", body, raw, signal } = {}) {
  const opts = { method, headers: { "X-NAS": "1" }, credentials: "same-origin", signal };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (raw !== undefined) opts.body = raw;
  const r = await fetch(path, opts);
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json(); else data = await r.text();
  if (!r.ok) {
    const detail = data && data.detail !== undefined ? data.detail : `Erreur ${r.status}`;
    if (r.status === 401 && detail === "Non connecté." && !path.startsWith("/api/public")) window.dispatchEvent(new Event("nas:logout"));
    if (r.status === 403 && (detail === "password_change_required" || detail === "2fa_required" || detail === "2fa_setup_required")) window.dispatchEvent(new CustomEvent("nas:" + detail));
    throw new ApiError(r.status, Array.isArray(detail) ? "Requête invalide." : detail);
  }
  return data;
}
export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: "POST", body });
export const put = (p, body = {}) => api(p, { method: "PUT", body });
export const del = (p) => api(p, { method: "DELETE" });
export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)).toString();

/** Envoi d'un fichier brut avec progression. Au-delà de 64 Mo : envoi par morceaux de 48 Mo, avec reprise
 *  (le proxy Cloudflare limite chaque requête à 100 Mo). */
const CHUNK = 48 * 1024 * 1024, CHUNK_MIN = 64 * 1024 * 1024;
function xhrPut(url, body, onProgress, holder) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("X-NAS", "1");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded);
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      x.status < 300 ? resolve(d) : reject(new ApiError(x.status, d.detail || `Erreur ${x.status}`));
    };
    x.onerror = () => reject(new ApiError(0, "Connexion perdue pendant l'envoi."));
    x.onabort = () => reject(new ApiError(-1, "Envoi annulé."));
    if (holder) holder.abort = () => x.abort();
    x.send(body);
  });
}
export async function upload(url, file, onProgress, holder) {
  const prog = (n) => onProgress && onProgress(Math.min(1, n / Math.max(1, file.size)));
  if (file.size < CHUNK_MIN) return xhrPut(url, file, prog, holder);
  const uid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const token = (url.match(/\/api\/public\/([^/]+)\//) || [])[1];
  const curl = (off) => `/api/chunks/${uid}?offset=${off}` + (token ? `&token=${encodeURIComponent(token)}` : "");
  let off = 0, fails = 0;
  while (off < file.size) {
    const end = Math.min(off + CHUNK, file.size);
    try {
      const r = await xhrPut(curl(off), file.slice(off, end), (n) => prog(off + n), holder);
      off = r.size; fails = 0;
    } catch (e) {
      if (e.status === -1 || e.status === 403 || e.status === 413 || ++fails > 5) throw e;
      await new Promise((res) => setTimeout(res, 1500 * fails));   // coupure : on attend puis on reprend
      try { off = (await (await fetch(`/api/chunks/${uid}`)).json()).size; } catch {}
    }
  }
  prog(file.size);
  return xhrPut(url + (url.includes("?") ? "&" : "?") + `chunk=${uid}&total=${file.size}`, null, null, holder);
}

// ---------------------------------------------------------------- formats
export function size(n) {
  if (n == null) return "—";
  const u = ["o", "Ko", "Mo", "Go", "To", "Po"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
}
export function date(ts, withTime = true) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) +
    (withTime ? " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "");
}
export function ago(ts) {
  if (!ts) return "jamais";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `il y a ${Math.floor(s / 86400)} j`;
  return date(ts, false);
}
export function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
export const initials = (name) => ((name || "?").split(/\s+/).filter((w) => /^\p{L}/u.test(w)).map((w) => w[0]).join("").slice(0, 2) || (name || "?")[0]).toUpperCase();

// ---------------------------------------------------------------- blocs de page
export function pageHeader({ title, desc, actions = "", back, icon: ic }) {
  return `<div class="page-header"><div class="titles">
    ${back ? `<a class="back" href="${esc(back.href)}" data-link>${icon("chevron-left")}${esc(back.label)}</a>` : ""}
    <h1>${ic ? icon(ic) : ""}${esc(title)}</h1>${desc ? `<p>${esc(desc)}</p>` : ""}</div>
    <div class="actions">${actions}</div></div>`;
}

/** Aide discrète, repliée : un petit lien « Comment ça marche ? ». */
export function helpBanner(key, title, html) {
  return `<details class="help"><summary>${icon("circle-help")} Comment ça marche ?</summary><div class="help-body">${html}</div></details>`;
}

export function emptyState(ic, title, text = "", action = "") {
  return `<div class="empty"><div class="ico">${icon(ic)}</div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}${action}</div>`;
}

export const spinner = () => `<div class="spinner"></div>`;

export function switchEl(name, checked, label = "", disabled = false) {
  return `<label class="switch"><input type="checkbox" name="${esc(name)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="track"></span>${label ? `<span>${esc(label)}</span>` : ""}</label>`;
}

export function chips(items, active, attr = "data-chip") {
  return `<div class="chips">${items.map((c) => `<button class="chip ${c.value === active ? "active" : ""}" ${attr}="${esc(c.value)}">${c.icon ? icon(c.icon) : ""}${esc(c.label)}${c.count != null ? ` <span class="count">${c.count}</span>` : ""}</button>`).join("")}</div>`;
}

export function tabs(items, active, attr = "data-tab") {
  return `<div class="tabs">${items.map((t) => `<button class="${t.value === active ? "active" : ""}" ${attr}="${esc(t.value)}">${t.icon ? icon(t.icon) : ""}${esc(t.label)}${t.badge ? ` <span class="badge">${t.badge}</span>` : ""}</button>`).join("")}</div>`;
}

export function bar(pct) {
  const cls = pct >= 95 ? "ko" : pct >= 85 ? "warn" : "";
  return `<div class="bar ${cls}"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;
}

// ---------------------------------------------------------------- toasts
export function toast(msg, type = "info", action) {
  let box = $(".toasts");
  if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.append(box); }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `${icon(type === "error" ? "circle-alert" : type === "success" ? "circle-check" : "info")}<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) t.querySelector("button").onclick = () => { t.remove(); action.onClick(); };
  box.append(t); paintIcons(t);
  setTimeout(() => t.remove(), action ? 7000 : type === "error" ? 6000 : 3200);
}
export const fail = (e) => toast(e?.message || String(e), "error");


// ---------------------------------------------------------------- feuilles (mobile) : glisser vers le bas pour fermer
export const isMobile = () => matchMedia("(max-width: 900px)").matches;
/** Rend une feuille du bas « attrapable » : on la tire vers le bas pour la fermer (comme sur iOS/Android). */
export function sheetDrag(panel, close) {
  if (!isMobile() || !("ontouchstart" in window)) return;
  let y0 = null, dy = 0, t0 = 0, scroller = null;
  panel.addEventListener("touchstart", (e) => {
    scroller = e.target.closest(".body, .msheet-scroll");
    if (scroller && scroller.scrollTop > 0) { y0 = null; return; }   // on fait défiler le contenu, pas la feuille
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now();
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { panel.style.transform = ""; return; }
    if (e.cancelable) e.preventDefault();
    panel.style.transition = "none"; panel.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  panel.addEventListener("touchend", () => {
    if (y0 === null) return; y0 = null;
    const fast = dy > 40 && Date.now() - t0 < 250;
    panel.style.transition = "transform .24s cubic-bezier(.2,.8,.2,1)";
    if (dy > 110 || fast) { panel.style.transform = "translateY(105%)"; setTimeout(close, 200); }
    else panel.style.transform = "";
  });
}

// ---------------------------------------------------------------- modale & panneau
export function modal({ title, body, actions = [], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
      <header><h3>${esc(title)}</h3><button class="btn ghost icon sm" data-close aria-label="Fermer">${icon("x")}</button></header>
      <div class="body">${body}</div>
      ${actions.length ? `<footer>${actions.map((a, i) => `<button class="btn ${a.cls || ""}" data-act="${i}">${a.icon ? icon(a.icon) : ""}${esc(a.label)}</button>`).join("")}</footer>` : ""}</div>`;
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(null); if (e.key === "Enter" && e.target.tagName === "INPUT") { const p = actions.findIndex((a) => a.primary); if (p >= 0) { e.preventDefault(); back.querySelector(`[data-act="${p}"]`).click(); } } };
    back.addEventListener("click", async (e) => {
      if (e.target === back || e.target.closest("[data-close]")) return close(null);
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const a = actions[+b.dataset.act];
      if (a.onClick) {
        b.disabled = true;
        try { const v = await a.onClick(back); if (v !== false) close(v ?? a.value ?? true); }
        catch (err) { fail(err); } finally { b.disabled = false; }
      } else close(a.value ?? null);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(back); paintIcons(back);
    const first = back.querySelector("input:not([type=checkbox]),select,textarea"); if (first) setTimeout(() => first.focus(), 30);
    sheetDrag(back.querySelector(".modal"), () => close(null));
    onOpen && onOpen(back);
  });
}

export const confirmBox = (title, text, { danger = false, ok = "Confirmer" } = {}) =>
  modal({ title, body: `<p style="margin:0">${text}</p>`, actions: [{ label: "Annuler", cls: "ghost", value: false }, { label: ok, cls: danger ? "danger solid" : "primary", value: true, primary: true }] });

export async function promptBox(title, label, value = "", { ok = "Valider", placeholder = "" } = {}) {
  return modal({
    title, body: `<label class="field"><span>${esc(label)}</span><input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
    actions: [{ label: "Annuler", cls: "ghost", value: null }, { label: ok, cls: "primary", primary: true, onClick: (m) => m.querySelector("[name=v]").value.trim() || false }],
    onOpen: (m) => { const i = m.querySelector("input"); const dot = value.lastIndexOf("."); setTimeout(() => i.setSelectionRange(0, dot > 0 ? dot : value.length), 40); },
  });
}

export function drawer({ title, body, footer = "", onOpen, onClose }) {
  const back = document.createElement("div"); back.className = "drawer-back";
  const d = document.createElement("aside"); d.className = "drawer";
  d.innerHTML = `<header><h3 class="ellipsis">${esc(title)}</h3><button class="btn ghost icon sm" data-close aria-label="Fermer">${icon("x")}</button></header><div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ""}`;
  const close = () => { back.remove(); d.remove(); document.removeEventListener("keydown", onKey); onClose && onClose(); };
  const onKey = (e) => e.key === "Escape" && close();
  back.onclick = close; d.querySelector("[data-close]").onclick = close;
  document.addEventListener("keydown", onKey);
  document.body.append(back, d); paintIcons(d);
  d.close = close;
  sheetDrag(d, close);
  onOpen && onOpen(d);
  return d;
}

/** Prévient avant de quitter une page avec des modifications non enregistrées. */
export function unsavedWarning(form) {
  let dirty = false;
  form.addEventListener("input", () => (dirty = true));
  const h = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", h);
  window.NAS.beforeLeave = () => !dirty || confirm("Des modifications ne sont pas enregistrées. Quitter quand même ?");
  return { clean: () => (dirty = false), dispose: () => window.removeEventListener("beforeunload", h) };
}

export function copy(text) {
  (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast("Copié dans le presse-papiers", "success"), () => {
    const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); toast("Copié", "success");
  });
}

const EXT = {
  doc: ["doc", "docx", "odt", "rtf", "pages"], sheet: ["xls", "xlsx", "ods", "csv", "numbers"], slides: ["ppt", "pptx", "odp", "key"],
  code: ["py", "js", "ts", "java", "sh", "html", "css", "json", "yml", "yaml", "toml", "xml", "sk", "mcfunction", "properties", "cfg", "conf", "ini", "sql", "go", "rs", "c", "cpp", "kt", "php"],
};
/** Type visuel d'un élément (plus fin que le type serveur). */
export function vkind(it) {
  if (it.dir || it.kind === "folder") return "folder";
  const ext = (it.name || "").split(".").pop().toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k;
  return it.kind || "file";
}
export function fileIcon(kind) {
  return { folder: "folder", image: "image", video: "clapperboard", audio: "audio-lines", pdf: "file-text", text: "file-text", archive: "file-archive",
    doc: "file-type-2", sheet: "file-spreadsheet", slides: "presentation", code: "file-code-2" }[kind] || "file";
}
export const KIND_LABEL = { folder: "Dossier", image: "Image", video: "Vidéo", audio: "Audio", pdf: "PDF", text: "Texte", archive: "Archive", doc: "Document", sheet: "Tableur", slides: "Présentation", code: "Code", file: "Fichier" };

export function avatar(name, cls = "") {
  const n = [...(name || "?")].reduce((a, c) => a + c.charCodeAt(0), 0) % 6;
  return `<div class="avatar ${n ? "c" + n : ""} ${cls}" title="${esc(name)}">${esc(initials(name))}</div>`;
}

/** Menu déroulant / contextuel. items: [{icon,label,onClick,danger,kbd}|"-"|{head}]. Feuille en bas sur mobile. */
export function menu(at, items) {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const m = document.createElement("div");
  const mobile = matchMedia("(max-width: 900px)").matches;
  m.className = "menu" + (mobile ? " sheet" : "");
  items = items.filter(Boolean).filter((it, i, a) => it !== "-" || (i > 0 && a[i - 1] !== "-" && !a[i - 1].head && i < a.length - 1));
  while (items[0] === "-") items.shift();
  while (items[items.length - 1] === "-") items.pop();
  m.innerHTML = items.map((it, i) => it === "-" ? "<hr>" : it.head ? `<div class="menu-head">${it.head}</div>` :
    `<button data-i="${i}" class="${it.danger ? "danger" : ""}">${icon(it.icon || "dot")}<span class="grow">${esc(it.label)}</span>${it.kbd && !mobile ? `<span class="kbd">${esc(it.kbd)}</span>` : ""}</button>`).join("");
  document.body.append(m); paintIcons(m);
  let back = null;
  if (mobile) { back = document.createElement("div"); back.className = "overlay"; back.style.zIndex = 119; document.body.insertBefore(back, m); }
  else {
    let x, y;
    if (at instanceof Event) { x = at.clientX; y = at.clientY; }
    else { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 6; if (x + m.offsetWidth > innerWidth - 8) x = r.right - m.offsetWidth; }
    x = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8));
    if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, (at instanceof Event ? y : at.getBoundingClientRect().top - 6) - m.offsetHeight);
    m.style.left = x + "px"; m.style.top = y + "px";
  }
  const close = () => { m.remove(); back?.remove(); document.removeEventListener("mousedown", out, true); document.removeEventListener("keydown", key); window.removeEventListener("blur", close); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  const key = (e) => e.key === "Escape" && close();
  setTimeout(() => { document.addEventListener("mousedown", out, true); document.addEventListener("keydown", key); window.addEventListener("blur", close); }, 0);
  back && (back.onclick = close);
  mobile && sheetDrag(m, close);
  const list = items;
  m.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (!b) return; close(); list[+b.dataset.i].onClick?.(); });
  return close;
}

/** Anneau de progression SVG. */
export function ring(p, size = 22) {
  const r = size / 2 - 2.5, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px"><circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}"/><circle class="fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}"/></svg>`;
}

/** Libellé d'un partage (ou d'un élément portant share_kind/share_owner). */
export function shareLabel(s) {
  const kind = s.share_kind ?? s.kind, owner = s.share_owner ?? s.owner_id, name = s.share_name ?? s.name;
  if (kind !== "personal") return name;
  if (owner === window.NAS?.me?.id) return "Mes fichiers";
  return "Espace de " + String(name).replace(/^perso-/, "");
}
export const isMine = (s) => (s.share_kind ?? s.kind) === "personal" && (s.share_owner ?? s.owner_id) === window.NAS?.me?.id;
/** URL d'un dossier (dans « Mes fichiers » si c'est le mien). */
export function folderUrl(shareOrItem, path, focus) {
  const mine = isMine(shareOrItem), sid = shareOrItem.share ?? shareOrItem.id;
  const q = new URLSearchParams(); if (!mine) q.set("s", sid); if (path) q.set("p", path); if (focus) q.set("f", focus);
  const qs = q.toString(); return "/fichiers" + (qs ? "?" + qs : "");
}

// Gestionnaires globaux (compatibles avec la CSP stricte : aucun script en ligne)
document.addEventListener("error", (e) => { if (e.target.tagName === "IMG" && e.target.hasAttribute("data-fb")) e.target.remove(); }, true);
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-reload],[data-click],[data-select]"); if (!t) return;
  if (t.hasAttribute("data-reload")) location.reload();
  if (t.dataset.click) document.querySelector(t.dataset.click)?.click();
  if (t.hasAttribute("data-select")) t.select();
});

/** Lien public (adresse Internet du NAS si configurée). */
export const publicLink = (path) => (window.NAS?.me?.public_url || location.origin) + path;

/** Champ de code à 6 chiffres : un vrai <input> unique (autoremplissage, collage, extensions MFA)
 *  superposé à 6 cases visuelles. autofill=false → invisible pour les extensions (ajout d'un nouvel appareil). */
export function otpField({ id = "mfa-code", name = "otp", autofill = true, label = "Code à 6 chiffres" } = {}) {
  const slots = [0, 1, 2, 3, 4, 5].map((i) => `<span class="slot" data-i="${i}"></span>${i === 2 ? `<span class="otp-sep"></span>` : ""}`).join("");
  return `<div class="otp" data-otp><input type="text" id="${esc(id)}" name="${esc(name)}" inputmode="numeric" pattern="[0-9]*" maxlength="6" required
    ${autofill ? `autocomplete="one-time-code" aria-label="${esc(label)}"` : `autocomplete="off" aria-label="Six chiffres" data-lpignore="true" data-1p-ignore`}
    spellcheck="false"><div class="otp-slots" aria-hidden="true">${slots}</div></div>`;
}

/** Active le rendu des cases ; onComplete(valeur) est appelé quand 6 chiffres sont saisis. */
export function bindOtp(box, onComplete) {
  const inp = box.querySelector("input"), slots = [...box.querySelectorAll(".slot")];
  const draw = () => {
    const clean = inp.value.replace(/\D/g, "").slice(0, 6);
    if (clean !== inp.value) inp.value = clean;
    const focused = document.activeElement === inp;
    slots.forEach((sl, i) => {
      sl.textContent = clean[i] || "";
      sl.classList.toggle("filled", i < clean.length);
      sl.classList.toggle("active", focused && i === Math.min(clean.length, 5) && clean.length < 6);
    });
    box.classList.toggle("complete", clean.length === 6);
  };
  ["input", "focus", "blur", "keyup", "change"].forEach((t) => inp.addEventListener(t, draw));
  inp.addEventListener("input", () => { box.classList.remove("error"); if (inp.value.length === 6 && onComplete) onComplete(inp.value); });
  draw();
  return { input: inp, draw, error() { box.classList.remove("error"); void box.offsetWidth; box.classList.add("error"); } };
}

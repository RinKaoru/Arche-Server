// Cadre de l'app : barre latérale (façon Drive), barre de recherche, menu du compte, routeur, connexion.
import { api, get, post, esc, icon, paintIcons, $, $$, toast, fail, spinner, menu, avatar, size, vkind, fileIcon, modal, promptBox, shareLabel, folderUrl, otpField, bindOtp, sheetDrag, isMobile } from "./ui.js";
import { TOOLS, visibleTools } from "./tools.js";
import { pick } from "./uploader.js";

const NAS = (window.NAS = { me: null, beforeLeave: null, cleanup: [], currentFolder: null });

const ROUTES = [
  [/^\/$/, "home"], [/^\/fichiers$/, "files"], [/^\/partages$/, "shared"], [/^\/recents$/, "files"], [/^\/favoris$/, "files"],
  [/^\/photos$/, "photos"], [/^\/albums$/, "albums"], [/^\/albums\/(\d+)$/, "albums"], [/^\/transferts$/, "transfers"], [/^\/liens$/, "transfers"],
  [/^\/notifications$/, "notifications"], [/^\/corbeille$/, "trash"], [/^\/synchro$/, "sync"], [/^\/compte$/, "account"], [/^\/guide$/, "guide"],
  [/^\/admin$/, "admin-overview"], [/^\/admin\/disques$/, "admin-disks"], [/^\/admin\/reseau$/, "admin-network"],
  [/^\/admin\/comptes$/, "admin-users"], [/^\/admin\/partages$/, "shares"], [/^\/admin\/snapshots$/, "admin-backups"],
  [/^\/admin\/github$/, "admin-github"], [/^\/admin\/docker$/, "admin-docker"], [/^\/admin\/audit$/, "admin-audit"],
  [/^\/admin\/reglages$/, "admin-settings"],
];
const toolFor = (path) => [...TOOLS].sort((a, b) => b.path.length - a.path.length).find((t) => path === t.path || (t.path !== "/" && path.startsWith(t.path + "/")));

// Historique : chaque entrée connaît sa profondeur, pour savoir si on avance ou on revient (animations, bouton retour).
const depth = () => history.state?.depth || 0;
let curDepth = depth();
export function navigate(url, replace = false, dir) {
  if (NAS.beforeLeave && !NAS.beforeLeave()) return;
  NAS.beforeLeave = null;
  const here = location.pathname + location.search;
  if (url === here && !replace) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (replace) history.replaceState({ ...history.state, depth: depth() }, "", url);
  else history.pushState({ depth: depth() + 1, prev: here }, "", url);
  curDepth = depth();
  NAS.navDir = dir || (replace ? "none" : "fwd");
  render();
  window.scrollTo(0, 0);
}
NAS.navigate = navigate;

/** Retour « intelligent » : dossier parent si la page l'indique, sinon l'écran précédent. */
export function goBack() {
  const to = NAS.backTo;
  if (to && history.state?.prev === to) return history.back();
  if (to) return navigate(to, false, "back");
  if (depth() > 0) return history.back();
}
NAS.goBack = goBack;

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link], a[href^='/']");
  if (!a || a.target === "_blank" || a.hasAttribute("download") || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("/api/") || href.startsWith("/s/") || href.startsWith("/static/")) return;
  e.preventDefault(); closeMenu(); navigate(href);
});
window.addEventListener("popstate", () => { if (NAS.onPop && NAS.onPop()) return; const d = depth(); NAS.navDir = d < curDepth ? "back" : d > curDepth ? "fwd" : "none"; curDepth = d; render(); });
window.addEventListener("nas:logout", () => { NAS.me = null; render(); });
window.addEventListener("nas:password_change_required", () => { if (NAS.me) { NAS.me.must_change = true; render(); } });
window.addEventListener("nas:2fa_setup_required", () => { if (NAS.me) { NAS.me.need_2fa_setup = true; render(); } });
window.addEventListener("nas:2fa_required", () => { if (NAS.me) { NAS.me.need2fa = true; render(); } });

async function boot() {
  if (location.pathname.startsWith("/s/")) return (await import("./pages/public.js")).default($("#app"), location.pathname.split("/")[2]);
  try { NAS.me = await get("/api/me"); } catch { NAS.me = null; }
  if (!history.state) history.replaceState({ depth: 0 }, "", location.href);
  render();
  setupGestures();
  if ("serviceWorker" in navigator) {
    // nouvelle version d'Arche publiée : on recharge une fois pour ne jamais mélanger ancien et nouveau code
    const had = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !reloaded && !document.querySelector(".modal-back, .viewer")) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register("/sw.js").then((r) => r.update()).catch(() => {});
  }
  setInterval(refreshMe, 60000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshMe());
  document.addEventListener("keydown", (e) => {
    if ((e.key === "/" || (e.key === "k" && (e.ctrlKey || e.metaKey))) && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $("#gs")?.focus(); }
  });
}

export async function refreshMe() {
  if (!NAS.me) return;
  try { NAS.me = await get("/api/me"); updateBadges(); } catch {}
}
NAS.refreshMe = refreshMe;

// ---------------------------------------------------------------- rendu
async function render() {
  NAS.cleanup.forEach((f) => { try { f(); } catch {} }); NAS.cleanup = [];
  NAS.currentFolder = null; NAS.backTo = null; NAS.pageTitle = null;
  const app = $("#app");
  document.title = NAS.me?.app_name || "NAS";
  if (!NAS.me) return renderLogin(app);
  if (NAS.me.must_change) return renderForcedPassword(app);
  if (NAS.me.need_2fa_setup && !NAS.me.totp_enabled) return renderForced2fa(app);
  const path = location.pathname;
  const tool = toolFor(path);
  const route = ROUTES.find(([re]) => re.test(path));
  if (tool?.space === "admin" && NAS.me.require_2fa_admin && !NAS.me.totp_enabled) NAS.me.need2fa = true;
  renderShell(app, tool);
  const old = $(".content"); const content = old.cloneNode(false); old.replaceWith(content); content.removeAttribute("style");
  const dir = NAS.navDir || "none"; NAS.navDir = null;
  if (dir !== "none") { content.classList.add("pg-" + dir); content.addEventListener("animationend", () => content.classList.remove("pg-" + dir), { once: true }); }
  if (!route) { content.innerHTML = empty("map-pin-off", "Page introuvable", `<a class="btn" href="/" data-link>Retour à l'accueil</a>`); return paintIcons(content); }
  if (tool && !visibleTools(NAS.me).includes(tool)) { content.innerHTML = empty("lock", "Accès réservé", "Demande à un administrateur si tu en as besoin."); return paintIcons(content); }
  if (tool?.space === "admin" && !NAS.me.internal) { content.innerHTML = empty("lock", "Administration réservée à la maison", "Pour ta sécurité, l'administration n'est accessible que depuis le réseau de la maison ou via le VPN Tailscale.", `<a class="btn" href="/" data-link>Retour à mes fichiers</a>`); return paintIcons(content); }
  if (tool?.space === "admin" && NAS.me.need2fa && !NAS.me.totp_enabled) return (await import("./pages/account.js")).require2fa(content);
  document.title = `${tool?.label || ""} · ${NAS.me.app_name}`;
  content.innerHTML = spinner();
  try {
    const mod = await import(`./pages/${route[1]}.js`);
    await mod.default(content, { params: path.match(route[0]).slice(1), query: new URLSearchParams(location.search), tool, path });
  } catch (e) {
    if (e?.status === 401) return;
    console.error(e);
    content.innerHTML = empty("triangle-alert", "La page n'a pas pu se charger", esc(e.message || e), `<button class="btn" data-reload>Recharger</button>`);
  }
  paintIcons(content);
  mobileChrome(tool);
  pairApp();
  if (!NAS.me.prefs?.onboarded && tool?.space === "me") onboarding();
}
NAS.render = render;
const empty = (ic, t, p = "", a = "") => `<div class="empty"><div class="ico">${icon(ic)}</div><h3>${esc(t)}</h3><p>${p}</p>${a}</div>`;

function navHtml(space, active) {
  const tools = visibleTools(NAS.me).filter((t) => t.space === space && !t.hidden);
  if (space === "me") {
    let html = "", sec = 0;
    for (const t of tools) {
      if (t.sec !== sec) { html += `<div class="nav-sep"></div>`; sec = t.sec; }
      html += `<a href="${t.path}" data-link class="${active?.id === t.id ? "active" : ""}">${icon(t.icon)}<span>${esc(t.label)}</span>${badgeHtml(t)}</a>`;
    }
    return html;
  }
  const groups = [];
  for (const t of tools) { let g = groups.find((x) => x.name === t.group); if (!g) groups.push((g = { name: t.group, items: [] })); g.items.push(t); }
  return groups.map((g) => `<div class="nav-title">${esc(g.name)}</div>${g.items.map((t) => `<a href="${t.path}" data-link class="${active?.id === t.id ? "active" : ""}">${icon(t.icon)}<span>${esc(t.label)}</span>${badgeHtml(t)}</a>`).join("")}`).join("");
}
function badgeHtml(t) {
  const n = t.badge === "unread" ? NAS.me.unread : t.badge === "alerts" ? NAS.me.active_alerts : 0;
  return `<span class="badge" data-badge="${t.badge || ""}" ${n ? "" : "hidden"}>${n || ""}</span>`;
}
function updateBadges() {
  $$("[data-badge]").forEach((b) => {
    const n = b.dataset.badge === "unread" ? NAS.me.unread : b.dataset.badge === "alerts" ? NAS.me.active_alerts : b.dataset.badge === "me" ? NAS.me.active_alerts : 0;
    b.textContent = n || ""; b.hidden = !n;
  });
}

let shellSpace = null;
function renderShell(app, tool) {
  const me = NAS.me, space = tool?.space || "me";
  if (!$(".app", app) || shellSpace !== space) {
    shellSpace = space;
    app.innerHTML = `<div class="app">
      <aside class="sidebar">
        <a class="brand" href="/" data-link><div class="logo">${icon("cloud")}</div><span class="app-name">${esc(me.app_name)}</span></a>
        ${space === "admin" ? `<a class="back-link" href="/" data-link>${icon("arrow-left")}Retour à mes fichiers</a><span class="admin-badge">${icon("shield")}Administration</span>`
          : `<button class="new-btn" id="new-btn">${icon("plus")}Nouveau</button>`}
        <nav class="nav"></nav>
        ${space === "me" ? `<div class="storage" id="storage"></div>` : ""}
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" id="menu-btn" aria-label="Menu">${icon("menu")}</button>
          <button class="tb-back" id="tb-back" aria-label="Retour" hidden>${icon("chevron-left")}<span></span></button>
          <div class="tb-title" id="tb-title"></div>
          ${space === "me" ? `<div class="gsearch">${icon("search")}<input id="gs" type="search" enterkeyhint="search" placeholder="Rechercher dans le NAS" autocomplete="off" spellcheck="false"><span class="kbd">/</span><button class="gs-cancel" id="gs-cancel" type="button">Annuler</button></div>` : `<div class="grow"></div>`}
          <div class="top-actions">
            ${space === "me" ? `<button class="icon-btn show-m" id="search-btn" aria-label="Rechercher">${icon("search")}</button>` : ""}
            <a class="icon-btn hide-m" href="/guide" data-link title="Aide">${icon("circle-help")}</a>
            <a class="icon-btn" href="/notifications" data-link title="Notifications">${icon("bell")}<span class="badge" data-badge="unread" ${me.unread ? "" : "hidden"}>${me.unread || ""}</span></a>
            <button class="me-btn" id="me-btn" title="${esc(me.display_name)}">${avatar(me.display_name)}<span class="badge" data-badge="me" ${me.active_alerts ? "" : "hidden"}>${me.active_alerts || ""}</span></button>
          </div>
        </header>
        <main class="content"></main>
      </div>
      <nav class="bottomnav"></nav>${space === "me" ? `<button class="fab" id="fab" aria-label="Nouveau">${icon("plus")}</button>` : ""}
    </div>`;
    $("#menu-btn", app).onclick = openMenu;
    $("#me-btn", app).onclick = (e) => accountMenu(e.currentTarget);
    $("#new-btn", app) && ($("#new-btn", app).onclick = (e) => newMenu(e.currentTarget));
    $("#fab", app) && ($("#fab", app).onclick = (e) => newMenu(e.currentTarget));
    $("#gs", app) && setupSearch($("#gs", app));
    $("#tb-back", app).onclick = goBack;
    $("#search-btn", app) && ($("#search-btn", app).onclick = () => { $(".topbar").classList.add("searching"); $("#gs").focus(); });
    $("#gs-cancel", app) && ($("#gs-cancel", app).onclick = () => { const i = $("#gs"); i.value = ""; i.dispatchEvent(new Event("input")); i.blur(); $(".topbar").classList.remove("searching"); });
    if (space === "me") loadStorage();
  }
  $(".nav", app).innerHTML = navHtml(space, tool);
  const bn = $(".bottomnav", app);
  if (bn) {
    const tabs = tabTools(space);
    const inTabs = tabs.some((t) => t.id === tool?.id);
    bn.innerHTML = tabs.map((t) => `<a href="${t.path}" data-link class="${tool?.id === t.id ? "active" : ""}"><i>${icon(t.icon)}</i><span>${esc(t.short || t.label)}</span></a>`).join("") +
      `<a href="#" id="more-btn" class="${inTabs ? "" : "active"}"><i>${icon(space === "admin" ? "ellipsis" : "layout-grid")}</i><span>Plus</span></a>`;
    $("#more-btn", app).onclick = (e) => { e.preventDefault(); moreSheet(space, tool); };
  }
  paintIcons(app);
}

const tabTools = (space) => visibleTools(NAS.me).filter((t) => t.mobile && t.space === space);

// ---------------------------------------------------------------- habillage mobile (barre du haut façon app)
function mobileChrome(tool) {
  const tb = $(".topbar"); if (!tb) return;
  tb.classList.remove("searching");
  const tabs = tabTools(tool?.space || "me");
  const root = tabs.some((t) => t.id === tool?.id) && !NAS.backTo;
  const back = $("#tb-back"), canBack = !root && (NAS.backTo || depth() > 0);
  back.hidden = !canBack;
  back.querySelector("span").textContent = "";
  $("#tb-title").textContent = NAS.pageTitle || tool?.label || "";
  tb.classList.toggle("has-back", !!canBack);
  const fab = $("#fab"); if (fab) fab.hidden = !["home", "files", "recent", "starred"].includes(tool?.id);
  onScroll();
}
function onScroll() { $(".topbar")?.classList.toggle("scrolled", window.scrollY > 36); }
window.addEventListener("scroll", onScroll, { passive: true });
NAS.setTitle = (t) => { NAS.pageTitle = t; const el = $("#tb-title"); if (el) el.textContent = t; };

// ---------------------------------------------------------------- feuille « Plus »
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; });
const inApp = () => !!window.ArcheApp;                       // dans l'app Android Arche
NAS.inApp = inApp;
const standalone = () => inApp() || matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isAndroid = /Android/i.test(navigator.userAgent);

/** App Android : après connexion, on lui donne un jeton limité à la sauvegarde des photos et aux notifications. */
let pairing = false;
async function pairApp() {
  if (!inApp() || !NAS.me || pairing) return;
  try { if (window.ArcheApp.pairedUser() === NAS.me.id) return; } catch { return; }
  pairing = true;
  try {
    const r = await post("/api/app/pair", { install_id: window.ArcheApp.installId(), name: window.ArcheApp.deviceName(), model: window.ArcheApp.deviceName() });
    window.ArcheApp.setToken(r.token, r.user.id, r.user.display_name);
  } catch {} finally { pairing = false; }
}

function moreSheet(space, current) {
  const me = NAS.me, tabs = tabTools(space).map((t) => t.id);
  const extra = visibleTools(me).filter((t) => t.space === space && !tabs.includes(t.id) && (!t.hidden || t.id === "notifications"));
  const tiles = extra.map((t) => `<a class="ms-tile ${current?.id === t.id ? "on" : ""}" href="${t.path}" data-link>${icon(t.icon)}<span>${esc(t.short || t.label)}</span>${t.badge === "unread" && me.unread ? `<b class="badge">${me.unread}</b>` : ""}</a>`).join("");
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const back = document.createElement("div"); back.className = "overlay ms-back";
  const sh = document.createElement("div"); sh.className = "msheet";
  sh.innerHTML = `<div class="grab"></div><div class="msheet-scroll">
    <a class="ms-me" href="/compte" data-link>${avatar(me.display_name)}<div class="grow"><b>${esc(me.display_name)}</b><span>${esc(me.username)} · ${esc({ admin: "Administrateur", membre: "Membre", invite: "Invité" }[me.role])}</span></div>${icon("chevron-right")}</a>
    <div class="ms-grid">${tiles}</div>
    <div class="ms-list">
      ${space === "admin" ? `<a href="/" data-link>${icon("arrow-left")}<span>Retour à mes fichiers</span>${icon("chevron-right")}</a>`
        : me.admin_space && me.internal ? `<a href="${visibleTools(me).find((t) => t.space === "admin").path}" data-link>${icon("shield")}<span>Administration</span>${me.active_alerts ? `<b class="badge">${me.active_alerts}</b>` : ""}${icon("chevron-right")}</a>` : ""}
      <a href="/guide" data-link>${icon("life-buoy")}<span>Aide et installation</span>${icon("chevron-right")}</a>
      ${inApp() ? "" : isAndroid ? `<a href="/synchro?app=1" data-link>${icon("download")}<span>Installer l'app Arche pour Android</span>${icon("chevron-right")}</a>`
        : !standalone() && (installEvt || ios) ? `<button data-install>${icon("download")}<span>Installer l'app sur l'écran d'accueil</span>${icon("chevron-right")}</button>` : ""}
      <button data-logout class="danger">${icon("log-out")}<span>Se déconnecter</span></button>
    </div>
    ${space === "me" ? `<div class="ms-storage" id="ms-storage"></div>` : ""}</div>`;
  document.body.append(back, sh); paintIcons(sh);
  const close = () => { sh.classList.add("out"); back.classList.add("out"); setTimeout(() => { sh.remove(); back.remove(); }, 200); };
  back.onclick = close;
  sh.addEventListener("click", async (e) => {
    if (e.target.closest("a[data-link]")) return close();
    if (e.target.closest("[data-logout]")) { close(); await post("/api/auth/logout").catch(() => {}); NAS.me = null; history.replaceState({ depth: 0 }, "", "/"); return render(); }
    if (e.target.closest("[data-install]")) {
      if (installEvt) { close(); installEvt.prompt(); installEvt = null; return; }
      modal({ title: "Installer l'app", body: `<div class="install-steps"><p>${icon("share")}<span>Dans Safari, touche le bouton <b>Partager</b> en bas de l'écran.</span></p><p>${icon("square-plus")}<span>Choisis <b>Sur l'écran d'accueil</b>, puis <b>Ajouter</b>.</span></p><p>${icon("smartphone")}<span>Ouvre <b>${esc(me.app_name)}</b> depuis l'écran d'accueil : plein écran, notifications et sauvegarde des photos.</span></p></div>`, actions: [{ label: "Compris", cls: "primary", value: true }] });
    }
  });
  sheetDrag(sh, close);
  if (space === "me") get("/api/storage").then((s) => {
    const el = $("#ms-storage", sh); if (!el) return;
    el.innerHTML = `<div class="row">${icon("cloud")}<span class="grow">Stockage du NAS</span><b>${Math.round(s.used / s.total * 100)} %</b></div><div class="meter"><i style="width:${Math.max(1, s.used / s.total * 100)}%"></i></div><small>${size(s.free)} libres sur ${size(s.total)}</small>`;
    paintIcons(el);
  }).catch(() => {});
}

// ---------------------------------------------------------------- gestes : bord gauche = retour, tirer en haut = actualiser
function setupGestures() {
  if (!("ontouchstart" in window)) return;
  let mode = null, x0 = 0, y0 = 0, dx = 0, dy = 0, ptr = null;
  const content = () => $(".content");
  const blocked = (e) => e.target.closest(".modal-back, .drawer, .menu, .msheet, .viewer, .overlay, input, textarea, .pgrid.selecting");
  document.addEventListener("touchstart", (e) => {
    mode = null; if (!NAS.me || !isMobile() || e.touches.length > 1 || blocked(e)) return;
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = dy = 0;
    if (x0 < 22 && standalone() && !inApp() && !$("#tb-back")?.hidden) mode = "back";   // dans l'app : geste retour d'Android
    else if (window.scrollY <= 0 && standalone()) mode = "ptr?";
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!mode) return;
    const t = e.touches[0]; dx = t.clientX - x0; dy = t.clientY - y0;
    if (mode === "back") {
      const c = content(); if (!c) return;
      c.style.transition = "none"; c.style.transform = `translateX(${Math.max(0, dx) * .85}px)`; c.style.opacity = String(1 - Math.min(dx, 300) / 900);
    } else if (mode === "ptr?") {
      if (Math.abs(dx) > Math.abs(dy) || dy < 0 || window.scrollY > 0) { mode = null; return; }
      if (dy > 8) { mode = "ptr"; ptr = document.createElement("div"); ptr.className = "ptr"; ptr.innerHTML = icon("arrow-down"); document.body.append(ptr); paintIcons(ptr); }
    }
    if (mode === "ptr") {
      const d = Math.min(dy * .5, 90);
      ptr.style.transform = `translateY(${d}px) rotate(${Math.min(dy * 1.4, 180)}deg)`; ptr.style.opacity = String(Math.min(1, d / 50));
      ptr.classList.toggle("ready", d >= 60);
    }
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (mode === "back") {
      const c = content(); if (!c) return;
      c.style.transition = "transform .22s var(--ease), opacity .22s";
      if (dx > 90) { c.style.transform = "translateX(100%)"; c.style.opacity = "0"; setTimeout(goBack, 160); }
      else { c.style.transform = ""; c.style.opacity = ""; }
    } else if (mode === "ptr" && ptr) {
      const p = ptr; ptr = null;
      if (p.classList.contains("ready")) {
        p.classList.add("spin"); p.innerHTML = icon("refresh-cw"); paintIcons(p); navigator.vibrate?.(8);
        Promise.resolve(refreshMe()).then(() => render()).finally(() => setTimeout(() => { p.classList.add("out"); setTimeout(() => p.remove(), 200); }, 250));
      } else { p.classList.add("out"); setTimeout(() => p.remove(), 200); }
    }
    mode = null;
  });
}

async function loadStorage() {
  try {
    const s = await get("/api/storage");
    const el = $("#storage"); if (!el) return;
    el.innerHTML = `<div class="row">${icon("cloud")}<span>Stockage</span></div><div class="meter"><i style="width:${Math.max(1, s.used / s.total * 100)}%"></i></div><small>${size(s.free)} libres sur ${size(s.total)}</small>`;
    paintIcons(el);
  } catch {}
}

function openMenu() {
  $(".sidebar").classList.add("open");
  const o = document.createElement("div"); o.className = "overlay"; o.onclick = closeMenu; document.body.append(o);
}
function closeMenu() { $(".sidebar")?.classList.remove("open"); $$(".overlay").forEach((o) => !o.nextElementSibling?.classList?.contains("menu") && o.remove()); }

function accountMenu(btn) {
  const me = NAS.me;
  menu(btn, [
    { head: `${avatar(me.display_name)}<div class="grow"><b>${esc(me.display_name)}</b><span>${esc(me.username)} · ${esc({ admin: "Administrateur", membre: "Membre", invite: "Invité" }[me.role])}</span></div>` },
    "-",
    { icon: "user-round", label: "Mon compte", onClick: () => navigate("/compte") },
    { icon: "bell", label: "Notifications" + (me.unread ? ` (${me.unread})` : ""), onClick: () => navigate("/notifications") },
    me.admin_space && me.internal && { icon: "shield", label: "Administration" + (me.active_alerts ? ` · ${me.active_alerts} alerte(s)` : ""), onClick: () => navigate(visibleTools(me).find((t) => t.space === "admin").path) },
    { icon: "life-buoy", label: "Aide et installation", onClick: () => navigate("/guide") },
    "-",
    { icon: "log-out", label: "Se déconnecter", onClick: async () => { await post("/api/auth/logout").catch(() => {}); NAS.me = null; history.replaceState({}, "", "/"); render(); } },
  ]);
}

export function newMenu(btn) {
  const me = NAS.me;
  const where = NAS.currentFolder?.level === "write" ? NAS.currentFolder.label : "Mes fichiers";
  menu(btn, [
    { icon: "folder-plus", label: "Nouveau dossier", kbd: "⇧N", onClick: () => window.dispatchEvent(new Event("nas:newfolder")) },
    "-",
    { icon: "file-up", label: `Importer des fichiers`, onClick: () => pick(false) },
    { icon: "folder-up", label: `Importer un dossier`, onClick: () => pick(true) },
    { icon: "smartphone", label: "Sauvegarde auto. du téléphone", onClick: () => navigate(inApp() ? "/synchro" : "/synchro?app=1") },
    { icon: "monitor", label: "Synchroniser un PC", onClick: () => navigate("/synchro?add=pc") },
    "-",
    { icon: "send", label: "Nouveau transfert", onClick: () => navigate("/transferts") },
    me.role !== "invite" && { icon: "folders", label: "Nouveau dossier partagé", onClick: () => navigate("/partages?new=1") },
    { icon: "inbox", label: "Demander des fichiers", onClick: () => navigate("/transferts?tab=demandes") },
  ]);
  void where;
}
NAS.newMenu = newMenu;

// création de dossier hors de la page Fichiers → dans Mes fichiers
window.addEventListener("nas:newfolder", async () => {
  if (NAS.currentFolder) return; // la page Fichiers gère elle-même
  const name = await promptBox("Nouveau dossier", "Nom", "Sans titre", { ok: "Créer" });
  if (!name) return;
  const shares = await get("/api/shares");
  const perso = shares.find((s) => s.kind === "personal" && s.owner_id === NAS.me.id);
  try { await post("/api/files/mkdir", { share: perso.id, path: "", name }); navigate(`/fichiers?p=${encodeURIComponent(name)}`); } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- recherche globale
function setupSearch(input) {
  const box = input.parentElement;
  let pop = null, t = null, results = [], idx = -1;
  const close = () => { pop?.remove(); pop = null; idx = -1; };
  const hl = (name, q) => { const i = name.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? esc(name) : esc(name.slice(0, i)) + `<mark>${esc(name.slice(i, i + q.length))}</mark>` + esc(name.slice(i + q.length)); };
  const open = (r) => {
    close(); input.value = ""; input.blur();
    const parent = r.path.split("/").slice(0, -1).join("/");
    navigate(r.dir ? folderUrl(r, r.path) : folderUrl(r, parent, r.name));
  };
  const draw = (q) => {
    if (!pop) { pop = document.createElement("div"); pop.className = "search-pop"; box.append(pop); }
    pop.innerHTML = results === null ? `<div class="hint">Recherche…</div>` : !results.length ? `<div class="hint">Aucun résultat pour « ${esc(q)} »</div>` :
      results.slice(0, 12).map((r, i) => { const k = vkind(r); return `<div class="res ${i === idx ? "on" : ""}" data-i="${i}"><span class="fic k-${k}">${icon(fileIcon(k))}</span>
        <div class="grow"><b>${hl(r.name, q)}</b><span>${esc(shareLabel(r))}${r.path.includes("/") ? " / " + esc(r.path.split("/").slice(0, -1).join(" / ")) : ""}</span></div></div>`; }).join("");
    paintIcons(pop);
    pop.onmousedown = (e) => { const el = e.target.closest("[data-i]"); if (el) { e.preventDefault(); open(results[+el.dataset.i]); } };
  };
  input.addEventListener("input", () => {
    const q = input.value.trim(); clearTimeout(t);
    if (q.length < 2) return close();
    results = null; draw(q);
    t = setTimeout(async () => { try { results = await get("/api/search?q=" + encodeURIComponent(q)); idx = -1; if (input.value.trim() === q) draw(q); } catch {} }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (!pop || !results?.length) { if (e.key === "Escape") input.blur(); return; }
    if (e.key === "ArrowDown") { idx = Math.min(idx + 1, Math.min(results.length, 12) - 1); draw(input.value.trim()); e.preventDefault(); }
    if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); draw(input.value.trim()); e.preventDefault(); }
    if (e.key === "Enter") open(results[Math.max(idx, 0)]);
    if (e.key === "Escape") { close(); input.blur(); }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// ---------------------------------------------------------------- accueil guidé (première visite)
async function onboarding() {
  NAS.me.prefs.onboarded = true;
  post("/api/me/prefs", { onboarded: true }).catch(() => {});
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const slides = [
    ["cloud", "o", `Bienvenue ${esc(NAS.me.display_name)} 👋`, `Voici <b>${esc(NAS.me.app_name)}</b>, le cloud de la maison. Tes fichiers et photos restent chez toi, accessibles depuis tous tes appareils.`],
    ["hard-drive", "b", "Tes fichiers, comme sur un Drive", "<b>Mes fichiers</b> est ton espace privé. <b>Partagés</b> contient les dossiers communs. Glisse-dépose des fichiers n'importe où pour les importer."],
    ["send", "p", "Envoie de gros fichiers", "Avec <b>Transferts</b>, crée un lien de téléchargement en un clic, ou demande à quelqu'un de t'envoyer des fichiers, sans compte."],
    ["smartphone", "g", "Installe l'app sur ton téléphone", ios ? "Dans Safari : bouton <b>Partager</b> → <b>Sur l'écran d'accueil</b>." : inApp() ? "Tu es dans l'app : va dans <b>Synchronisation</b> pour que toutes tes photos soient sauvegardées toutes seules." : /Android/i.test(navigator.userAgent) ? "Installe l'app <b>Arche</b> pour Android (menu <b>Plus</b>) : tes photos seront sauvegardées toutes seules, comme avec Google Photos." : "Sur Android, installe l'app <b>Arche</b> (page <b>Synchronisation</b>) : tes photos seront sauvegardées toutes seules."],
  ];
  let i = 0;
  await modal({
    title: "", body: `<div class="onb" id="onb"></div>`,
    actions: [{ label: "Passer", cls: "ghost", value: true }, { label: "Suivant", cls: "primary", onClick: (m) => { if (i < slides.length - 1) { i++; draw(m); return false; } return true; } }],
    onOpen: (m) => { m.querySelector("header").hidden = true; draw(m); },
  });
  function draw(m) {
    const [ic, c, t, p] = slides[i];
    $("#onb", m).innerHTML = `<div class="art qi ${c}">${icon(ic)}</div><h2>${t}</h2><p>${p}</p><div class="dots">${slides.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</div>`;
    m.querySelector("footer .primary").textContent = i === slides.length - 1 ? "C'est parti" : "Suivant";
    paintIcons(m);
  }
}

// ---------------------------------------------------------------- connexion
const brand = () => `<div class="brand"><div class="logo">${icon("cloud")}</div><span>${esc(NAS.me?.app_name || "Arche")}</span></div>`;

function renderLogin(app) {
  shellSpace = null;
  app.innerHTML = `<div class="login-wrap"><div class="login">${brand()}
    <form class="card" id="login-form" method="post" action="/api/auth/login" autocomplete="on" novalidate>
      <div id="step-pw">
        <h2>Connexion</h2><p class="muted" style="margin:0 0 20px">Le cloud de la famille.</p>
        <div class="err" hidden></div>
        <label class="field"><span>Identifiant</span><input class="input" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" required autofocus></label>
        <label class="field"><span>Mot de passe</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      </div>
      <div id="step-totp" hidden>
        <div class="mfa-head"><div class="badge-ico">${icon("shield-check")}</div><h2>Vérification en deux étapes</h2>
          <p>Saisis le code à 6 chiffres affiché par ton application d'authentification.</p></div>
        <div class="err" hidden></div>
        <div id="otp-slot"></div>
      </div>
      <button class="btn primary lg block" type="submit" id="login-btn">Continuer</button>
      <div class="mfa-foot" id="mfa-foot" hidden><button type="button" id="mfa-back">${icon("arrow-left")}Retour</button><span class="mfa-timer" id="mfa-timer"></span></div>
    </form></div></div>`;
  paintIcons(app);
  const f = $("#login-form"), btn = $("#login-btn");
  let busy = false, otp = null, timer = null;
  const showErr = (msg) => { const e = $((otp ? "#step-totp" : "#step-pw") + " .err", f); e.textContent = msg; e.hidden = !msg; };
  // (re)crée le champ : un champ neuf à chaque refus, pour que les extensions MFA puissent réessayer
  const mountOtp = () => {
    $("#otp-slot", f).innerHTML = otpField({ id: "mfa-code", name: "totp" });
    otp = bindOtp($("#otp-slot [data-otp]", f), () => { if (!busy) f.requestSubmit(); });
    setTimeout(() => otp.input.focus(), 30);
  };
  const tick = () => {
    const left = 30 - (Math.floor(Date.now() / 1000) % 30), r = 6.5, c = 2 * Math.PI * r;
    $("#mfa-timer", f).innerHTML = `<svg viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="${r}"/><circle class="fg" cx="8" cy="8" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - left / 30)}"/></svg>Nouveau code dans ${left} s`;
  };
  const toTotp = () => {
    $("#step-pw").hidden = true; $("#step-totp").hidden = false; $("#mfa-foot").hidden = false;
    btn.textContent = "Vérifier"; mountOtp(); tick(); timer = setInterval(tick, 1000);
  };
  $("#mfa-back").onclick = () => {
    clearInterval(timer); otp = null; $("#otp-slot", f).innerHTML = "";
    $("#step-totp").hidden = true; $("#mfa-foot").hidden = true; $("#step-pw").hidden = false; btn.textContent = "Continuer";
    $("[name=password]", f).value = ""; $("[name=password]", f).focus();
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;                       // un seul envoi à la fois (validation auto + clic d'une extension)
    if (otp && otp.input.value.length !== 6) { otp.error(); return; }
    busy = true; btn.disabled = true; showErr("");
    const label = btn.textContent; btn.textContent = otp ? "Vérification…" : "Connexion…";
    otp && $("[data-otp]", f).classList.add("busy");
    try {
      const r = await api("/api/auth/login", { method: "POST", body: Object.fromEntries(new FormData(f)) });
      if (r.need_totp) { busy = false; btn.disabled = false; return toTotp(); }
      otp && $("[data-otp]", f).classList.replace("busy", "success");
      clearInterval(timer);
      NAS.me = await get("/api/me"); render();
    } catch (ex) {
      busy = false; btn.disabled = false; btn.textContent = label;
      showErr(ex.message);
      otp && $("[data-otp]", f).classList.remove("busy");
      if (otp) { otp.error(); setTimeout(() => otp && mountOtp(), 450); }   // nouveau nœud DOM après un refus
    }
  };
}

async function renderForced2fa(app) {
  shellSpace = null;
  app.innerHTML = `<div class="login-wrap"><div class="login">${brand()}
    <div class="card center"><div class="qi o" style="width:60px;height:60px;border-radius:20px;display:grid;place-items:center;margin:0 auto 14px">${icon("shield-check")}</div>
      <h2>Sécurise ton compte</h2><p class="muted" style="margin:6px 0 20px">Tu te connectes depuis l'extérieur de la maison. Pour protéger le NAS, active la double authentification : un code à 6 chiffres sur ton téléphone, en plus du mot de passe. Ça prend une minute.</p>
      <button class="btn primary lg block" id="go2fa">Activer la double authentification</button>
      <button class="btn ghost block" style="margin-top:8px" id="lo">Se déconnecter</button></div></div></div>`;
  paintIcons(app);
  $("#lo").onclick = async () => { await post("/api/auth/logout").catch(() => {}); NAS.me = null; render(); };
  $("#go2fa").onclick = async () => { const m = await import("./pages/account.js"); m.setup2fa(async () => { NAS.me = await get("/api/me"); render(); }); };
}

function renderForcedPassword(app) {
  shellSpace = null;
  app.innerHTML = `<div class="login-wrap"><div class="login">${brand()}
    <form class="card" id="pw-form">
      <h2>Bienvenue ${esc(NAS.me.display_name)} 👋</h2>
      <p class="muted" style="margin:4px 0 20px">Choisis ton mot de passe personnel. Il servira partout : app, téléphone et ordinateurs.</p>
      <div class="err" hidden></div>
      <label class="field"><span>Mot de passe provisoire</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>Nouveau mot de passe</span><input class="input" type="password" name="new" autocomplete="new-password" minlength="10" required><small>10 caractères minimum — une petite phrase, c'est parfait.</small></label>
      <label class="field"><span>Confirmation</span><input class="input" type="password" name="new2" autocomplete="new-password" required></label>
      <button class="btn primary lg block" type="submit">Enregistrer</button>
      <button class="btn ghost block" style="margin-top:8px" type="button" id="lo">Se déconnecter</button>
    </form></div></div>`;
  paintIcons(app);
  $("#lo").onclick = async () => { await post("/api/auth/logout").catch(() => {}); NAS.me = null; render(); };
  $("#pw-form").onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target)); const err = $(".err", e.target);
    if (d.new !== d.new2) { err.textContent = "Les deux mots de passe sont différents."; err.hidden = false; return; }
    try { await post("/api/me/password", d); NAS.me = await get("/api/me"); toast("Mot de passe enregistré", "success"); render(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

boot();

// Gestionnaire de fichiers façon Google Drive : grille/liste, sélection souris+clavier, menu contextuel, panneau détails,
// glisser-déposer, récents et favoris.
import { get, post, qs, esc, icon, paintIcons, $, $$, size, date, ago, toast, fail, modal, confirmBox, promptBox, menu, copy,
  vkind, fileIcon, KIND_LABEL, spinner, shareLabel, folderUrl, publicLink } from "../ui.js";
import { viewer, PREVIEWABLE } from "../viewer.js";
import { enqueue, pick } from "../uploader.js";

export { viewer };
const S = { items: [], sel: new Set(), last: -1, mode: "folder", share: null, path: "", stars: new Set() };
const pref = (k, d) => window.NAS.me.prefs?.[k] ?? d;
const setPref = (k, v) => { window.NAS.me.prefs[k] = v; post("/api/me/prefs", { [k]: v }).catch(() => {}); };
const touch = matchMedia("(pointer: coarse)").matches;
const phone = () => matchMedia("(max-width: 900px)").matches;
const key = (it) => `${it.share}:${it.path}`;

export default async function (el, { query, path }) {
  S.sel.clear(); S.last = -1;
  S.mode = path === "/recents" ? "recent" : path === "/favoris" ? "starred" : "folder";
  S.view = pref("view", "grid"); S.sort = pref("sort", { by: "name", dir: 1 }); S.details = pref("details", false);
  get("/api/favorites/keys").then((k) => { S.stars = new Set(k); }).catch(() => {});
  if (S.mode === "folder") {
    let sid = query.get("s");
    if (!sid) {
      const shares = await get("/api/shares");
      sid = shares.find((s) => s.kind === "personal" && s.owner_id === window.NAS.me.id)?.id;
    }
    try {
      const d = await get("/api/files/list?" + qs({ share: sid, path: query.get("p") || "" }));
      S.share = d.share; S.path = d.path;
      S.items = d.items.map((i) => ({ ...i, share: d.share.id }));
      const label = shareLabel(d.share);
      window.NAS.currentFolder = { share: d.share.id, path: d.path, level: d.share.level, label: d.path ? d.path.split("/").pop() : label };
      const mine = d.share.kind === "personal" && d.share.owner_id === window.NAS.me.id;
      window.NAS.backTo = d.path ? folderUrl(d.share, d.path.split("/").slice(0, -1).join("/")) : mine ? null : "/partages";
      window.NAS.pageTitle = d.path ? d.path.split("/").pop() : mine ? "Mes fichiers" : label;
    } catch (e) {
      el.innerHTML = `<div class="empty"><div class="ico">${icon("folder-x")}</div><h3>Dossier inaccessible</h3><p>${esc(e.message)}</p><a class="btn" href="/fichiers" data-link>Mes fichiers</a></div>`;
      return paintIcons(el);
    }
  } else if (S.mode === "recent") {
    S.items = await get("/api/recent?limit=80");
  } else {
    S.items = await get("/api/favorites");
  }
  draw(el);
  bindGlobal(el);
  const focus = query.get("f");
  if (focus) { const i = S.items.findIndex((x) => x.name === focus); if (i >= 0) { S.sel.add(key(S.items[i])); S.last = i; draw(el); el.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "center" }); } }
}

// ------------------------------------------------------------------ rendu
function sorted() {
  if (S.mode === "recent") return S.items;
  const { by, dir } = S.sort;
  return [...S.items].sort((a, b) => (b.dir - a.dir) || dir * (by === "name" ? a.name.localeCompare(b.name, "fr", { numeric: true }) : by === "size" ? a.size - b.size : a.mtime - b.mtime));
}

function draw(el) {
  const items = (S.list = sorted());
  const writable = S.mode !== "folder" || S.share.level === "write";
  const head = S.sel.size ? selBar() : topBar();
  let body;
  if (!items.length) body = emptyHtml(writable);
  else if (S.view === "list" || S.mode === "recent" || phone()) body = listHtml(items);
  else body = gridHtml(items);
  el.innerHTML = `${head}<div class="drive ${S.details ? "with-details" : ""}"><div class="drive-main" id="dm">${body}</div>${S.details ? `<aside class="details" id="details"></aside>` : ""}</div>`;
  paintIcons(el);
  if (S.details) drawDetails(el);
  bindItems(el);
}

function topBar() {
  let crumbs;
  if (S.mode === "recent") crumbs = `<span>Récents</span>`;
  else if (S.mode === "starred") crumbs = `<span>Favoris</span>`;
  else {
    const perso = S.share.kind === "personal" && S.share.owner_id === window.NAS.me.id;
    const parts = S.path ? S.path.split("/") : [];
    const root = perso ? `<a href="/fichiers" data-link>Mes fichiers</a>` : S.share.kind === "personal" ? `<a href="${url("")}" data-link>${esc(shareLabel(S.share))}</a>` : `<a href="/partages" data-link class="hide-m">Partagés</a>${icon("chevron-right")}<a href="${url("")}" data-link>${esc(S.share.name)}</a>`;
    crumbs = (parts.length > 2 ? root + icon("chevron-right") + `<button data-crumbs>…</button>` + parts.slice(-1).map((p) => `${icon("chevron-right")}<button data-here>${esc(p)}${icon("chevron-down")}</button>`).join("")
      : root + parts.map((p, i) => `${icon("chevron-right")}${i === parts.length - 1 ? `<button data-here>${esc(p)}${icon("chevron-down")}</button>` : `<a href="${url(parts.slice(0, i + 1).join("/"))}" data-link>${esc(p)}</a>`}`).join(""));
    if (!parts.length) crumbs = crumbs.replace(/<a href="[^"]*" data-link>([^<]*)<\/a>$/, `<button data-here>$1${icon("chevron-down")}</button>`);
    if (S.share.level === "read") crumbs += ` <span class="tag" style="margin-left:8px">${icon("eye")}Lecture seule</span>`;
  }
  return `<div class="fbar"><div class="crumbs">${crumbs}</div>
    ${S.mode !== "recent" ? `<div class="seg icons"><button data-view="list" class="${S.view === "list" ? "active" : ""}" title="Liste">${icon("list")}</button><button data-view="grid" class="${S.view === "grid" ? "active" : ""}" title="Grille">${icon("layout-grid")}</button></div>
    <button class="btn ghost sm" data-sort>${icon("arrow-up-down")}${{ name: "Nom", mtime: "Date", size: "Taille" }[S.sort.by]}</button>` : ""}
    <button class="icon-btn hide-m ${S.details ? "active" : ""}" data-details title="Détails" style="${S.details ? "color:var(--accent-2);background:var(--accent-soft)" : ""}">${icon("info")}</button></div>`;
}

function selBar() {
  const n = S.sel.size, one = n === 1 ? selected()[0] : null, w = canWrite(selected());
  return `<div class="selbar"><button class="icon-btn" data-a="clear" title="Tout désélectionner">${icon("x")}</button><b>${n} sélectionné${n > 1 ? "s" : ""}</b>
    ${one ? `<button class="icon-btn" data-a="link" title="Partager un lien">${icon("link")}</button>` : ""}
    <button class="icon-btn" data-a="download" title="Télécharger">${icon("download")}</button>
    ${w ? `<button class="icon-btn" data-a="move" title="Déplacer">${icon("folder-input")}</button>` : ""}
    ${w ? `<button class="icon-btn" data-a="delete" title="Supprimer">${icon("trash-2")}</button>` : ""}
    <button class="icon-btn" data-a="more" title="Plus d'actions">${icon("ellipsis-vertical")}</button><span class="grow"></span>
    <button class="icon-btn hide-m" data-details title="Détails" style="${S.details ? "color:var(--accent-2);background:var(--accent-soft)" : ""}">${icon("info")}</button></div>`;
}

function thumbImg(it, sz = 320) {
  return (it.kind === "image" || it.kind === "video") ? `<img loading="lazy" src="/api/files/thumb?${qs({ share: it.share, path: it.path, size: sz })}" alt="" data-fb>` : "";
}
const star = (it) => S.stars.has(key(it)) ? icon("star", "star-mini") : "";

function gridHtml(items) {
  const folders = items.map((it, i) => [it, i]).filter(([it]) => it.dir), files = items.map((it, i) => [it, i]).filter(([it]) => !it.dir);
  return (folders.length ? `${files.length ? `<div class="group-label">Dossiers</div>` : ""}<div class="folders">${folders.map(([it, i]) => `<div class="folder ${S.sel.has(key(it)) ? "selected" : ""}" data-i="${i}" draggable="true">
      ${icon("folder", "fi")}<span class="nm" title="${esc(it.name)}">${esc(it.name)}</span>${star(it)}<button class="icon-btn more" data-more>${icon("ellipsis-vertical")}</button></div>`).join("")}</div>` : "") +
    (files.length ? `${folders.length ? `<div class="group-label">Fichiers</div>` : ""}<div class="tiles">${files.map(([it, i]) => { const k = vkind(it); return `<div class="tile ${S.sel.has(key(it)) ? "selected" : ""}" data-i="${i}" draggable="true">
      <div class="tname">${icon(fileIcon(k), "ti k-" + k)}<span title="${esc(it.name)}">${esc(it.name)}</span>${star(it)}<button class="icon-btn more" data-more>${icon("ellipsis-vertical")}</button></div>
      <div class="prev k-${k}">${icon(fileIcon(k))}${thumbImg(it)}${it.kind === "video" ? `<span class="play">${icon("play")}</span>` : ""}</div></div>`; }).join("")}</div>` : "");
}

function listHtml(items) {
  const arrow = (by) => S.sort.by === by ? icon(S.sort.dir > 0 ? "arrow-up" : "arrow-down") : "";
  const rec = S.mode === "recent";
  return `<div class="list"><div class="lhead"><button data-sortby="name">Nom ${rec ? "" : arrow("name")}</button><button data-sortby="mtime">${rec ? "Activité" : "Modifié " + arrow("mtime")}</button><button data-sortby="size">Taille ${rec ? "" : arrow("size")}</button><span></span></div>
    ${items.map((it, i) => { const k = vkind(it); const where = S.mode !== "folder" ? shareLabel(it) + (it.path.includes("/") ? " / " + it.path.split("/").slice(0, -1).join(" / ") : "") : "";
      return `<div class="lrow ${S.sel.has(key(it)) ? "selected" : ""}" data-i="${i}" draggable="true">
      <div class="nm"><span class="fic k-${k}">${icon(fileIcon(k))}${thumbImg(it)}</span><div><span title="${esc(it.name)}">${esc(it.name)} ${star(it)}</span><span class="sub">${esc(where || (it.dir ? "Dossier" : size(it.size) + " · " + ago(it.mtime)))}</span></div></div>
      <div class="meta">${rec ? `${esc({ upload: "Importé", mkdir: "Créé", rename: "Renommé", move: "Déplacé", copy: "Copié", restore: "Restauré", received: "Reçu" }[it.action] || "Modifié")} ${ago(it.at)}` : date(it.mtime)}</div>
      <div class="meta">${it.dir ? "—" : size(it.size)}</div>
      <div class="ra"><button class="icon-btn hide-m" data-q="link" title="Partager">${icon("link")}</button><button class="icon-btn hide-m" data-q="download" title="Télécharger">${icon("download")}</button><button class="icon-btn" data-more title="Plus">${icon("ellipsis-vertical")}</button></div></div>`; }).join("")}</div>`;
}

function emptyHtml(writable) {
  if (S.mode === "recent") return `<div class="empty"><div class="ico">${icon("clock")}</div><h3>Rien de récent</h3><p>Les fichiers que tu importes, crées ou modifies apparaîtront ici.</p></div>`;
  if (S.mode === "starred") return `<div class="empty"><div class="ico">${icon("star")}</div><h3>Aucun favori</h3><p>Ajoute une étoile aux fichiers et dossiers importants pour les retrouver ici en un clic (clic droit → Ajouter aux favoris).</p></div>`;
  return `<div class="empty"><div class="ico">${icon(writable ? "upload-cloud" : "folder-open")}</div><h3>${writable ? "Dépose tes fichiers ici" : "Ce dossier est vide"}</h3>
    <p>${writable ? "Glisse des fichiers ou des dossiers depuis ton ordinateur, ou utilise le bouton ci-dessous." : ""}</p>
    ${writable ? `<div class="actions" style="justify-content:center"><button class="btn primary" data-up>${icon("upload")}Importer des fichiers</button><button class="btn" data-mk>${icon("folder-plus")}Nouveau dossier</button></div>` : ""}</div>`;
}

const url = (p) => folderUrl(S.share, p);
const selected = () => S.list.filter((it) => S.sel.has(key(it)));
const canWrite = (its) => S.mode === "folder" ? S.share.level === "write" : its.every((it) => it.share_kind !== undefined);
const reload = () => window.NAS.render();

// ------------------------------------------------------------------ panneau détails
async function drawDetails(el) {
  const box = $("#details", el); if (!box) return;
  const sel = selected();
  const it = sel.length === 1 ? sel[0] : null;
  if (!it) {
    const n = S.items.length, total = S.items.reduce((a, x) => a + (x.size || 0), 0);
    box.innerHTML = `<div class="dhead"><b class="grow">${S.mode === "folder" ? esc(window.NAS.currentFolder.label) : S.mode === "recent" ? "Récents" : "Favoris"}</b><button class="icon-btn" data-details>${icon("x")}</button></div>
      <div class="dprev k-folder">${icon(sel.length > 1 ? "files" : "folder-open")}</div><div class="dbody">
      ${sel.length > 1 ? `<h4>${sel.length} éléments sélectionnés</h4><p class="muted small">${size(sel.reduce((a, x) => a + (x.size || 0), 0))}</p>` :
        `<h4>${n} élément${n > 1 ? "s" : ""}</h4><p class="muted small">${size(total)} au total. Sélectionne un fichier pour voir ses détails.</p>`}
      ${S.mode === "folder" && S.share.kind !== "personal" ? `<div class="dsec"><h5>Dossier partagé</h5><p class="small muted" style="margin:0">${esc(S.share.name)} — accès ${S.share.level === "write" ? "en écriture" : "en lecture seule"}.</p></div>` : ""}</div>`;
    paintIcons(box); return;
  }
  const k = vkind(it);
  box.innerHTML = `<div class="dhead"><span class="fic k-${k}" style="width:24px;height:24px">${icon(fileIcon(k))}</span><b class="grow ellipsis">${esc(it.name)}</b><button class="icon-btn" data-details>${icon("x")}</button></div>
    <div class="dprev k-${k}">${icon(fileIcon(k))}${thumbImg(it, 640)}</div>
    <div class="dbody"><div class="dacts">
      ${!it.dir && PREVIEWABLE.includes(it.kind) ? `<button class="btn sm" data-q="open">${icon("eye")}Ouvrir</button>` : it.dir ? `<button class="btn sm" data-q="open">${icon("folder-open")}Ouvrir</button>` : ""}
      <button class="btn sm" data-q="link">${icon("link")}Partager</button><button class="btn sm icon" data-q="download" title="Télécharger">${icon("download")}</button>
      <button class="btn sm icon" data-q="star" title="Favori">${icon("star")}</button></div>
    <dl><dt>Type</dt><dd>${esc(KIND_LABEL[k] || "Fichier")}</dd>${it.dir ? "" : `<dt>Taille</dt><dd>${size(it.size)}</dd>`}
      <dt>Emplacement</dt><dd>${esc(it.share_kind ? shareLabel(it) : shareLabel(S.share))}${it.path.includes("/") ? " / " + esc(it.path.split("/").slice(0, -1).join(" / ")) : ""}</dd>
      <dt>Modifié</dt><dd>${date(it.mtime)}</dd></dl>
    ${it.dir ? "" : `<div class="dsec"><h5>Versions précédentes</h5><div id="vers" class="small muted">Chargement…</div></div>`}</div>`;
  paintIcons(box);
  if (!it.dir) {
    try {
      const vs = await get("/api/files/versions?" + qs({ share: it.share, path: it.path }));
      const vb = $("#vers", box); if (!vb) return;
      vb.innerHTML = vs.length ? vs.slice(0, 8).map((v) => `<div class="ver">${icon("history")}<span class="grow">${esc(new Date(v.date).toLocaleDateString("fr-FR", { day: "numeric", month: "long" }))}<span class="faint"> · ${size(v.size)}</span></span>
        <button class="btn sm ghost" data-ver="${v.date}">Restaurer</button></div>`).join("") : `Aucune pour l'instant. Le NAS garde une version chaque nuit.`;
      paintIcons(vb);
      vb.onclick = async (e) => { const b = e.target.closest("[data-ver]"); if (!b) return;
        try { const r = await post("/api/files/restore-version", { share: it.share, path: it.path, date: b.dataset.ver }); toast(`Copie restaurée : ${r.name}`, "success"); reload(); } catch (er) { fail(er); } };
    } catch {}
  }
}

// ------------------------------------------------------------------ interactions
function bindItems(el) {
  const dm = $("#dm", el);
  const idxOf = (t) => { const r = t.closest("[data-i]"); return r ? +r.dataset.i : -1; };
  const redraw = () => draw(el);
  const select = (i, e) => {
    const it = S.list[i];
    if (e?.shiftKey && S.last >= 0) { const [a, b] = [Math.min(S.last, i), Math.max(S.last, i)]; if (!(e.ctrlKey || e.metaKey)) S.sel.clear(); for (let j = a; j <= b; j++) S.sel.add(key(S.list[j])); }
    else if (e?.ctrlKey || e?.metaKey || (touch && S.sel.size)) { S.sel.has(key(it)) ? S.sel.delete(key(it)) : S.sel.add(key(it)); S.last = i; }
    else { S.sel.clear(); S.sel.add(key(it)); S.last = i; }
    redraw();
  };
  dm.addEventListener("click", (e) => {
    if (e.target.closest("[data-up]")) return pick(false);
    if (e.target.closest("[data-mk]")) return newFolder();
    if (lpFired) { lpFired = false; return; }            // relâchement d'un appui long : déjà traité
    const i = idxOf(e.target);
    if (i < 0) { if (S.sel.size && !e.target.closest(".lhead")) { S.sel.clear(); redraw(); } return; }
    const it = S.list[i];
    if (touch && !S.sel.size && e.target.closest("[data-more]")) return itemMenu(e.target.closest("[data-more]"), [it]);
    if (e.target.closest("[data-more]")) { if (!S.sel.has(key(it))) { S.sel.clear(); S.sel.add(key(it)); S.last = i; redraw(); } return itemMenu(e.target.closest("[data-more]"), selected()); }
    const q = e.target.closest("[data-q]")?.dataset.q; if (q) return act(q, [it]);
    if (touch && !S.sel.size) return open(it);
    select(i, e);
  });
  dm.addEventListener("dblclick", (e) => { const i = idxOf(e.target); if (i >= 0 && !touch) open(S.list[i]); });
  dm.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (touch) return;                                     // sur mobile, l'appui long sélectionne (géré plus bas)
    const i = idxOf(e.target);
    if (i < 0) return folderMenu(e);
    if (!S.sel.has(key(S.list[i]))) { S.sel.clear(); S.sel.add(key(S.list[i])); S.last = i; redraw(); }
    itemMenu(e, selected());
  });
  // appui long (mobile) = sélection
  let lp, lpFired = false;
  dm.addEventListener("touchstart", (e) => { lpFired = false; const i = idxOf(e.target); if (i < 0 || e.target.closest("[data-more]")) return; lp = setTimeout(() => { lp = null; lpFired = true; navigator.vibrate?.(10); S.sel.add(key(S.list[i])); S.last = i; redraw(); }, 450); }, { passive: true });
  ["touchend", "touchmove"].forEach((t) => dm.addEventListener(t, () => clearTimeout(lp), { passive: true }));
  // tri / vue / détails / fil d'Ariane
  el.addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]"); if (v) { S.view = v.dataset.view; setPref("view", S.view); return redraw(); }
    const sb = e.target.closest("[data-sortby]"); if (sb && S.mode !== "recent") { const by = sb.dataset.sortby; S.sort = { by, dir: S.sort.by === by ? -S.sort.dir : by === "name" ? 1 : -1 }; setPref("sort", S.sort); return redraw(); }
    if (e.target.closest("[data-sort]")) return menu(e.target.closest("[data-sort]"), [["name", "Nom", "a-large-small"], ["mtime", "Date de modification", "calendar"], ["size", "Taille", "hard-drive"]].map(([by, l, ic]) =>
      ({ icon: S.sort.by === by ? "check" : ic, label: l, onClick: () => { S.sort = { by, dir: by === "name" ? 1 : -1 }; setPref("sort", S.sort); redraw(); } })));
    if (e.target.closest("[data-details]")) { S.details = !S.details; setPref("details", S.details); return redraw(); }
    if (e.target.closest("[data-here]")) return folderMenu(e.target.closest("[data-here]"));
    if (e.target.closest("[data-crumbs]")) { const parts = S.path.split("/"); return menu(e.target.closest("[data-crumbs]"), parts.slice(0, -1).map((p, i) => ({ icon: "folder", label: p, onClick: () => window.NAS.navigate(url(parts.slice(0, i + 1).join("/"))) }))); }
    const a = e.target.closest(".selbar [data-a]")?.dataset.a;
    if (a === "clear") { S.sel.clear(); redraw(); } else if (a === "more") itemMenu(e.target.closest("[data-a]"), selected()); else if (a) act(a, selected());
    const dq = e.target.closest("#details [data-q]")?.dataset.q; if (dq) act(dq, selected());
  });
  // glisser un élément sur un dossier = déplacer
  if (S.mode === "folder" && S.share.level === "write") {
    dm.addEventListener("dragstart", (e) => { const i = idxOf(e.target); if (i < 0) return; const it = S.list[i]; if (!S.sel.has(key(it))) { S.sel.clear(); S.sel.add(key(it)); } e.dataTransfer.setData("text/nas", JSON.stringify(selected().map((x) => x.path))); e.dataTransfer.effectAllowed = "move"; });
    dm.addEventListener("dragover", (e) => { const i = idxOf(e.target); if (i >= 0 && S.list[i].dir && e.dataTransfer.types.includes("text/nas")) { e.preventDefault(); e.target.closest("[data-i]").classList.add("drop"); } });
    dm.addEventListener("dragleave", (e) => e.target.closest?.("[data-i]")?.classList.remove("drop"));
    dm.addEventListener("drop", async (e) => {
      const i = idxOf(e.target); const raw = e.dataTransfer.getData("text/nas");
      if (i < 0 || !raw || !S.list[i].dir) return;
      e.preventDefault(); e.stopPropagation();
      const paths = JSON.parse(raw).filter((p) => p !== S.list[i].path);
      try { await post("/api/files/move", { share: S.share.id, paths, dest_share: S.share.id, dest_path: S.list[i].path }); toast(`Déplacé dans « ${S.list[i].name} »`, "success"); reload(); } catch (er) { fail(er); }
    });
  }
}

function bindGlobal(el) {
  // clavier
  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector(".modal-back,.drawer,.viewer,.menu")) return;
    const sel = selected();
    if ((e.ctrlKey || e.metaKey) && e.key === "a") { e.preventDefault(); S.list.forEach((it) => S.sel.add(key(it))); draw(el); }
    else if (e.key === "Escape" && S.sel.size) { S.sel.clear(); draw(el); }
    else if ((e.key === "Delete" || e.key === "Backspace") && sel.length && canWrite(sel)) { e.preventDefault(); act("delete", sel); }
    else if (e.key === "F2" && sel.length === 1) { e.preventDefault(); act("rename", sel); }
    else if (e.key === "Enter" && sel.length === 1) open(sel[0]);
    else if (e.key === " " && sel.length === 1 && !sel[0].dir) { e.preventDefault(); open(sel[0]); }
    else if (e.key === "N" && e.shiftKey && S.mode === "folder") { e.preventDefault(); newFolder(); }
    else if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key) && S.list.length) {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : (e.key === "ArrowDown" ? 1 : -1) * (S.view === "grid" ? Math.max(1, Math.floor(($("#dm").clientWidth) / 214)) : 1);
      const i = Math.max(0, Math.min(S.list.length - 1, (S.last < 0 ? 0 : S.last + step)));
      S.sel.clear(); S.sel.add(key(S.list[i])); S.last = i; draw(el); el.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };
  document.addEventListener("keydown", onKey);
  const onUp = () => reload();
  const onNew = () => newFolder();
  window.addEventListener("nas:uploaded", onUp);
  window.addEventListener("nas:newfolder", onNew);
  window.NAS.cleanup.push(() => { document.removeEventListener("keydown", onKey); window.removeEventListener("nas:uploaded", onUp); window.removeEventListener("nas:newfolder", onNew); });
  // glisser-déposer depuis l'ordinateur
  if (S.mode !== "folder" || S.share.level !== "write") return;
  let dz = null, depth = 0;
  const enter = (e) => { if (!e.dataTransfer.types.includes("Files")) return; depth++; if (!dz) { dz = document.createElement("div"); dz.className = "dropzone"; dz.innerHTML = `<div class="dz"><div class="ico">${icon("upload")}</div><b>Dépose pour importer</b><span>dans « ${esc(window.NAS.currentFolder.label)} »</span></div>`; document.body.append(dz); paintIcons(dz); } };
  const leave = () => { if (--depth <= 0) { dz?.remove(); dz = null; depth = 0; } };
  const over = (e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); };
  const drop = async (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault(); dz?.remove(); dz = null; depth = 0;
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const files = [];
    const walk = (en, pre) => new Promise((res) => {
      if (en.isFile) en.file((f) => { files.push({ file: f, name: pre + f.name }); res(); }, res);
      else { const rd = en.createReader(), all = []; const rd1 = () => rd.readEntries(async (es) => { if (!es.length) { for (const x of all) await walk(x, pre + en.name + "/"); res(); } else { all.push(...es); rd1(); } }, res); rd1(); }
    });
    if (entries.length) { for (const en of entries) await walk(en, ""); } else files.push(...[...e.dataTransfer.files].map((f) => ({ file: f, name: f.name })));
    enqueue(files, { share: S.share.id, path: S.path, label: window.NAS.currentFolder.label });
  };
  document.addEventListener("dragenter", enter); document.addEventListener("dragleave", leave);
  document.addEventListener("dragover", over); document.addEventListener("drop", drop);
  window.NAS.cleanup.push(() => { document.removeEventListener("dragenter", enter); document.removeEventListener("dragleave", leave); document.removeEventListener("dragover", over); document.removeEventListener("drop", drop); dz?.remove(); });
}

// ------------------------------------------------------------------ menus
function itemMenu(at, its) {
  const one = its.length === 1 ? its[0] : null, w = canWrite(its);
  const starred = its.every((it) => S.stars.has(key(it)));
  menu(at, [
    one && { icon: one.dir ? "folder-open" : "eye", label: "Ouvrir", kbd: "↵", onClick: () => open(one) },
    one && S.mode !== "folder" && { icon: "folder-search", label: "Afficher dans le dossier", onClick: () => reveal(one) },
    "-",
    { icon: "download", label: its.length > 1 || one?.dir ? "Télécharger (.zip)" : "Télécharger", onClick: () => act("download", its) },
    one && { icon: "link", label: "Partager un lien", onClick: () => act("link", its) },
    { icon: "star", label: starred ? "Retirer des favoris" : "Ajouter aux favoris", onClick: () => act(starred ? "unstar" : "star", its) },
    "-",
    one && w && { icon: "pencil", label: "Renommer", kbd: "F2", onClick: () => act("rename", its) },
    w && { icon: "folder-input", label: "Déplacer vers…", onClick: () => act("move", its) },
    { icon: "copy", label: "Copier vers…", onClick: () => act("copy", its) },
    one && { icon: "info", label: "Détails et versions", onClick: () => { S.details = true; setPref("details", true); draw($(".content")); } },
    w && "-",
    w && { icon: "trash-2", label: "Mettre à la corbeille", kbd: "Suppr", danger: true, onClick: () => act("delete", its) },
  ]);
}

function folderMenu(at) {
  if (S.mode !== "folder") return;
  const w = S.share.level === "write";
  const here = { share: S.share.id, path: S.path, name: window.NAS.currentFolder.label, dir: true };
  menu(at, [
    w && { icon: "folder-plus", label: "Nouveau dossier", kbd: "⇧N", onClick: newFolder },
    w && { icon: "file-up", label: "Importer des fichiers", onClick: () => pick(false) },
    w && { icon: "folder-up", label: "Importer un dossier", onClick: () => pick(true) },
    w && "-",
    { icon: "link", label: "Partager ce dossier par lien", onClick: () => linkDialog(here) },
    w && { icon: "inbox", label: "Recevoir des fichiers ici", onClick: () => requestDialog(here) },
    { icon: "download", label: "Tout télécharger (.zip)", onClick: () => dl(`/api/files/zip?${qs({ share: S.share.id, paths: S.path })}`) },
    { icon: "star", label: S.stars.has(`${S.share.id}:${S.path}`) ? "Retirer des favoris" : "Ajouter aux favoris", onClick: () => act(S.stars.has(`${S.share.id}:${S.path}`) ? "unstar" : "star", [here]) },
    "-",
    { icon: "monitor", label: "Ouvrir sur un ordinateur", onClick: smbInfo },
  ]);
}

function open(it) {
  if (it.dir) return window.NAS.navigate(it.share === S.share?.id ? url(it.path) : folderUrl(it, it.path));
  const list = S.list.filter((x) => !x.dir && PREVIEWABLE.includes(x.kind));
  if (!PREVIEWABLE.includes(it.kind)) return dl(raw(it, 1));
  viewer(list, list.indexOf(it), { raw, small: (x) => `/api/files/thumb?${qs({ share: x.share, path: x.path, size: 320 })}`, play: (x, hevc) => "/api/files/play?" + qs({ share: x.share, path: x.path, hevc }), thumb: (x) => `/api/files/thumb?${qs({ share: x.share, path: x.path, size: 1280 })}`, text: (x) => "/api/files/text?" + qs({ share: x.share, path: x.path }) }, { share: (x) => linkDialog(x) });
}
const raw = (it, d) => "/api/files/raw?" + qs({ share: it.share, path: it.path, dl: d || undefined });
const dl = (href) => { const a = document.createElement("a"); a.href = href; a.download = ""; document.body.append(a); a.click(); a.remove(); };
function reveal(it) {
  const parent = it.path.split("/").slice(0, -1).join("/");
  window.NAS.navigate(folderUrl(it, parent, it.name));
}

async function act(a, its) {
  const one = its[0];
  try {
    if (a === "open") return open(one);
    if (a === "download") {
      if (its.length === 1 && !one.dir) return dl(raw(one, 1));
      const sh = one.share; if (its.some((x) => x.share !== sh)) return its.forEach((x, i) => setTimeout(() => x.dir ? dl(`/api/files/zip?${qs({ share: x.share, paths: x.path })}`) : dl(raw(x, 1)), i * 400));
      return dl(`/api/files/zip?${qs({ share: sh, paths: its.map((x) => x.path).join("|") })}`);
    }
    if (a === "link") return linkDialog(one);
    if (a === "star" || a === "unstar") {
      for (const it of its) { await post("/api/favorites", { share: it.share, path: it.path, on: a === "star" }); a === "star" ? S.stars.add(key(it)) : S.stars.delete(key(it)); }
      toast(a === "star" ? "Ajouté aux favoris" : "Retiré des favoris", "success");
      return S.mode === "starred" ? reload() : draw($(".content"));
    }
    if (a === "rename") {
      const n = await promptBox("Renommer", "Nouveau nom", one.name, { ok: "Renommer" });
      if (n && n !== one.name) { await post("/api/files/rename", { share: one.share, path: one.path, name: n }); reload(); }
    }
    if (a === "move" || a === "copy") return moveDialog(its, a === "copy");
    if (a === "delete") {
      const byShare = {};
      its.forEach((it) => (byShare[it.share] ||= []).push(it.path));
      for (const [sh, paths] of Object.entries(byShare)) await post("/api/files/delete", { share: +sh, paths });
      S.sel.clear(); reload();
      const me = window.NAS.me.username;
      toast(its.length > 1 ? `${its.length} éléments mis à la corbeille` : `« ${one.name} » mis à la corbeille`, "info", {
        label: "Annuler", onClick: async () => {
          try {
            const trash = await get("/api/trash");
            const items = its.flatMap((it) => trash.filter((t) => t.share === it.share && (t.item === `${me}/${it.path}` || t.item.startsWith(`${me}/${it.path}/`))).map((t) => ({ share: t.share, item: t.item })));
            await post("/api/trash/restore", { items }); toast("Restauré", "success"); reload();
          } catch (e) { fail(e); }
        } });
    }
  } catch (e) { fail(e); }
}

async function newFolder() {
  if (S.mode !== "folder" || S.share.level !== "write") return;
  const name = await promptBox("Nouveau dossier", "Nom du dossier", "Sans titre", { ok: "Créer" });
  if (!name) return;
  try { await post("/api/files/mkdir", { share: S.share.id, path: S.path, name }); reload(); } catch (e) { fail(e); }
}

function smbInfo() {
  const host = location.hostname, sub = S.share.name + (S.path ? "/" + S.path : "");
  modal({ title: "Ouvrir sur un ordinateur", body: `<p class="muted" style="margin-top:0">Ce dossier s'ouvre aussi comme un lecteur réseau, avec les mêmes identifiant et mot de passe que l'app.</p>
    <label class="field"><span>Windows — Explorateur, barre d'adresse</span><input class="input mono" readonly value="\\\\${esc(host)}\\${esc(sub.replace(/\//g, "\\"))}" data-select></label>
    <label class="field"><span>Mac — Finder › Aller › Se connecter au serveur</span><input class="input mono" readonly value="smb://${esc(host)}/${esc(sub)}" data-select></label>`, actions: [{ label: "OK", cls: "primary" }] });
}

// ------------------------------------------------------------------ dialogues réutilisables
export async function moveDialog(its, isCopy) {
  const shares = (await get("/api/shares")).filter((s) => s.level === "write" && !["timemachine", "system"].includes(s.kind));
  let cur = { share: its[0].share, path: its[0].path.split("/").slice(0, -1).join("/") };
  if (!shares.some((s) => s.id === cur.share)) cur = { share: shares[0].id, path: "" };
  const refresh = async (m) => {
    const r = await get("/api/files/list?" + qs({ share: cur.share, path: cur.path }));
    const sh = shares.find((s) => s.id === cur.share);
    const parts = cur.path ? cur.path.split("/") : [];
    $("#mv-crumbs", m).innerHTML = `<a data-p="">${esc(shareLabel(sh))}</a>` + parts.map((p, i) => `${icon("chevron-right")}<a data-p="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("");
    const dirs = r.items.filter((i) => i.dir && !(cur.share === its[0].share && its.some((x) => x.path === i.path)));
    $("#mv-list", m).innerHTML = dirs.length ? dirs.map((d) => `<div class="picker-row" data-p="${esc(d.path)}">${icon("folder")}<span class="grow ellipsis">${esc(d.name)}</span>${icon("chevron-right")}</div>`).join("") : `<div class="faint small" style="padding:18px;text-align:center">Aucun sous-dossier — tu peux déplacer ici.</div>`;
    paintIcons(m);
  };
  const ok = await modal({
    title: `${isCopy ? "Copier" : "Déplacer"} ${its.length > 1 ? its.length + " éléments" : "« " + its[0].name + " »"}`, wide: true,
    body: `<select class="input" id="mv-share" style="margin-bottom:12px">${shares.map((s) => `<option value="${s.id}" ${s.id === cur.share ? "selected" : ""}>${esc(shareLabel(s))}</option>`).join("")}</select>
      <div class="crumbs small" id="mv-crumbs"></div><div id="mv-list" style="max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:4px"></div>`,
    actions: [{ label: "Annuler", cls: "ghost" }, { label: isCopy ? "Copier ici" : "Déplacer ici", cls: "primary", onClick: async () => {
      const byShare = {}; its.forEach((it) => (byShare[it.share] ||= []).push(it.path));
      for (const [sh, paths] of Object.entries(byShare)) await post("/api/files/move", { share: +sh, paths, dest_share: cur.share, dest_path: cur.path, copy: isCopy });
      return true; } }],
    onOpen: (m) => { refresh(m); $("#mv-share", m).onchange = (e) => { cur = { share: +e.target.value, path: "" }; refresh(m); }; m.addEventListener("click", (e) => { const p = e.target.closest("[data-p]"); if (p) { cur.path = p.dataset.p; refresh(m); } }); },
  });
  if (ok) { toast(isCopy ? "Copié" : "Déplacé", "success"); S.sel.clear(); reload(); }
}

export async function linkDialog(it) {
  const r = await modal({
    title: `Partager « ${it.name} »`,
    body: `<p class="muted" style="margin-top:0">Toute personne qui a le lien pourra ${it.dir ? "voir et télécharger ce dossier" : "télécharger ce fichier"}, sans compte.</p>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><label class="field"><span>Expiration</span><select class="input" name="exp"><option value="1">1 jour</option><option value="7" selected>7 jours</option><option value="30">30 jours</option><option value="0">Jamais</option></select></label>
      <label class="field"><span>Mot de passe</span><input class="input" name="pw" type="text" autocomplete="off" placeholder="Facultatif"></label></div>
      <p class="faint small" style="margin:0">${icon("globe")} Le lien fonctionne partout, depuis Internet.</p>`,
    actions: [{ label: "Annuler", cls: "ghost" }, { label: "Créer le lien", cls: "primary", primary: true, onClick: async (m) => post("/api/links", { share: it.share, path: it.path, expires_days: +$("[name=exp]", m).value, password: $("[name=pw]", m).value }) }],
  });
  if (r) shareResult(publicLink(r.url), "Lien prêt à partager");
}

export async function requestDialog(it) {
  const r = await modal({
    title: "Recevoir des fichiers",
    body: `<p class="muted" style="margin-top:0">Envoie ce lien à quelqu'un : il pourra déposer des fichiers dans « ${esc(it.name)} », sans compte. Tu seras notifié à chaque envoi.</p>
      <label class="field"><span>Titre affiché</span><input class="input" name="t" value="${esc(it.name)}"></label>
      <label class="field"><span>Message (facultatif)</span><textarea class="input" name="m" placeholder="Salut ! Dépose ici les photos du week-end 🙂"></textarea></label>
      <label class="field"><span>Le lien expire</span><select class="input" name="exp"><option value="7">dans 7 jours</option><option value="30" selected>dans 30 jours</option><option value="0">jamais</option></select></label>`,
    actions: [{ label: "Annuler", cls: "ghost" }, { label: "Créer le lien", cls: "primary", onClick: async (m) => post("/api/requests", { share: it.share, path: it.path, title: $("[name=t]", m).value, message: $("[name=m]", m).value, expires_days: +$("[name=exp]", m).value }) }],
  });
  if (r) shareResult(publicLink(r.url), "Lien de dépôt prêt");
}

export function shareResult(link, title) {
  modal({ title, body: `<div class="row" style="background:var(--panel);border:1px solid var(--line-2);border-radius:12px;padding:6px 6px 6px 14px"><span class="grow mono ellipsis">${esc(link)}</span><button class="btn primary sm" id="cp">${icon("copy")}Copier</button></div>
    ${navigator.share ? `<button class="btn block" id="sh" style="margin-top:12px">${icon("share-2")}Envoyer via…</button>` : ""}`,
    actions: [{ label: "Terminé", cls: "ghost" }],
    onOpen: (m) => { $("#cp", m).onclick = () => copy(link); $("#sh", m) && ($("#sh", m).onclick = () => navigator.share({ url: link }).catch(() => {})); } });
}

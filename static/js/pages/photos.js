// Photos façon iCloud : grille bord à bord par mois, carte, sélection, albums, sauvegarde du téléphone.
import { get, post, qs, upload, esc, icon, paintIcons, $, size, toast, modal, ring, menu } from "../ui.js";
import { viewer } from "../viewer.js";

const S = { items: [], filter: 0, done: false, sel: new Set(), selecting: false };

export default async function (el, { query }) {
  S.items = []; S.done = false; S.sel.clear(); S.selecting = false;
  const tab = query.get("tab") || "all";
  el.innerHTML = `<div class="page-header"><div class="titles"><h1>Photos</h1></div>
    <div class="actions"><div class="seg"><button data-tab="all" class="${tab === "all" ? "active" : ""}">${icon("grid-3x3")}<span class="hide-m">Photothèque</span></button><button data-tab="map" class="${tab === "map" ? "active" : ""}">${icon("map")}<span class="hide-m">Carte</span></button><button data-alb>${icon("book-image")}<span class="hide-m">Albums</span></button></div>
    ${tab === "all" ? `<button class="btn" id="selmode">Sélectionner</button>` : ""}<button class="btn primary" id="bk">${icon("smartphone")}<span class="hide-m">Sauvegarder mon téléphone</span><span class="show-m">Sauvegarder</span></button></div></div>
    <input type="file" id="bk-in" accept="image/*,video/*" multiple hidden><div id="ph"></div>`;
  paintIcons(el);
  el.querySelector(".seg").onclick = (e) => {
    if (e.target.closest("[data-alb]")) return window.NAS.navigate("/albums");
    const b = e.target.closest("[data-tab]"); if (b) window.NAS.navigate("/photos" + (b.dataset.tab === "map" ? "?tab=map" : ""), true);
  };
  $("#bk", el).onclick = (e) => menu(e.currentTarget, [
    { icon: "refresh-cw", label: window.ArcheApp ? "Réglages de la sauvegarde automatique" : "Sauvegarde automatique (app Android)", onClick: () => window.NAS.navigate(window.ArcheApp ? "/synchro" : "/synchro?app=1") },
    { icon: "image-up", label: "Choisir des photos maintenant", onClick: () => $("#bk-in", el).click() },
  ]);
  $("#bk-in", el).onchange = (e) => { backup([...e.target.files], el); e.target.value = ""; };
  $("#selmode", el) && ($("#selmode", el).onclick = () => { S.selecting = !S.selecting; if (!S.selecting) S.sel.clear(); draw(el); });
  if (query.get("backup")) setTimeout(() => $("#bk-in", el).click(), 250);
  tab === "map" ? renderMap(el) : renderTimeline(el);
}

async function renderTimeline(el) {
  const box = $("#ph", el);
  box.innerHTML = `<div class="spinner"></div>`;
  const r = await get("/api/photos/timeline?" + qs({ limit: 400, share: S.filter || undefined }));
  S.items = r.items; S.done = r.items.length < 400; S.shares = r.shares; S.total = r.total;
  if (!r.total && !S.filter) {
    box.innerHTML = `<div class="empty"><div class="ico">${icon("images")}</div><h3>Aucune photo pour l'instant</h3><p>Sauvegarde les photos de ton téléphone : elles seront rangées par date, à l'abri, à la maison.</p>
      <button class="btn primary" data-click="#bk-in">${icon("smartphone")}Sauvegarder mon téléphone</button></div>`;
    return paintIcons(box);
  }
  box.innerHTML = `<div id="selbar"></div>${r.shares.length > 1 ? `<div class="chips">${[{ id: 0, name: "Toutes" }, ...r.shares].map((s) => `<button class="chip ${s.id === S.filter ? "active" : ""}" data-f="${s.id}">${esc(s.name.startsWith("perso-") ? "Mes photos" : s.name)}</button>`).join("")}</div>` : ""}<div id="grid"></div><div id="more" style="height:40px"></div>`;
  box.querySelector(".chips")?.addEventListener("click", (e) => { const c = e.target.closest("[data-f]"); if (c) { S.filter = +c.dataset.f; renderTimeline(el); } });
  draw(el);
  const io = new IntersectionObserver(async (ents) => {
    if (!ents[0].isIntersecting || S.done || S.loading) return;
    S.loading = true;
    const more = await get("/api/photos/timeline?" + qs({ limit: 400, before: S.items[S.items.length - 1].taken_at, share: S.filter || undefined }));
    S.items.push(...more.items); S.done = more.items.length < 400; S.loading = false; draw(el);
  }, { rootMargin: "1000px" });
  io.observe($("#more", box));
  window.NAS.cleanup.push(() => io.disconnect());
  $("#grid", box).addEventListener("click", (e) => {
    const t = e.target.closest("[data-id]"); if (!t) return;
    const id = +t.dataset.id;
    if (S.selecting || e.target.closest(".sel") || S.sel.size) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); t.classList.toggle("selected"); drawSel(el); return; }
    openViewer(S.items, S.items.findIndex((p) => p.id === id));
  });
}

function draw(el) {
  const grid = $("#grid", el); if (!grid) return;
  const months = new Map();
  for (const p of S.items) {
    const k = new Date(p.taken_at * 1000).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    (months.get(k) || months.set(k, []).get(k)).push(p);
  }
  grid.innerHTML = [...months].map(([m, ps]) => `<div class="month">${esc(m[0].toUpperCase() + m.slice(1))} <span class="faint">${ps.length} élément${ps.length > 1 ? "s" : ""}</span></div><div class="pgrid">${ps.map(tile).join("")}</div>`).join("");
  paintIcons(grid);
  const sm = $("#selmode", el); if (sm) sm.textContent = S.selecting ? "Terminé" : "Sélectionner";
  drawSel(el);
}

export const tile = (p) => `<div class="ptile ${S.sel.has(p.id) ? "selected" : ""}" data-id="${p.id}"><img loading="lazy" src="/api/photos/${p.id}/thumb" alt="">${p.video ? `<span class="vid">${icon("play")}</span>` : ""}<span class="sel"></span></div>`;

function drawSel(el) {
  const n = S.sel.size, sb = $("#selbar", el); if (!sb) return;
  el.classList.toggle("selecting", n > 0 || S.selecting);
  sb.innerHTML = n ? `<div class="selbar"><button class="icon-btn" data-a="clear">${icon("x")}</button><b>${n} sélectionnée${n > 1 ? "s" : ""}</b><span class="grow"></span>
    <button class="btn sm ghost" data-a="dl">${icon("download")}<span class="hide-m">Télécharger</span></button>
    <button class="btn sm primary" data-a="album">${icon("book-plus")}Ajouter à un album</button></div>` : "";
  paintIcons(sb);
  sb.onclick = async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "clear") { S.sel.clear(); draw(el); }
    if (a === "dl") [...S.sel].forEach((id, i) => setTimeout(() => { const x = document.createElement("a"); x.href = `/api/photos/${id}/raw?dl=1`; x.download = ""; document.body.append(x); x.click(); x.remove(); }, i * 350));
    if (a === "album" && await addToAlbum([...S.sel])) { S.sel.clear(); S.selecting = false; draw(el); }
  };
}

export function openViewer(items, idx) {
  viewer(items.map((p) => ({ ...p, kind: p.video ? "video" : "image" })), idx, {
    raw: (it, dl) => `/api/photos/${it.id}/raw${dl ? "?dl=1" : ""}`,
    small: (it) => `/api/photos/${it.id}/thumb`,
    thumb: (it) => `/api/photos/${it.id}/thumb?size=1280`,
    play: (it, hevc) => `/api/photos/${it.id}/play?hevc=${hevc}`,
  }, { album: (it) => addToAlbum([it.id]) });
}

export async function addToAlbum(ids) {
  const albums = await get("/api/albums");
  const r = await modal({
    title: "Ajouter à un album",
    body: `${albums.length ? `<div style="max-height:260px;overflow:auto;margin:0 -8px 10px">${albums.map((a) => `<div class="picker-row" data-a="${a.id}"><div class="fic" style="background:var(--elev-3);border-radius:10px;width:40px;height:40px">${a.last_photo ? `<img src="/api/photos/${a.last_photo}/thumb">` : icon("book-image")}</div><span class="grow"><b style="font-weight:550">${esc(a.name)}</b><br><span class="faint small">${a.n} élément(s)</span></span>${icon("plus")}</div>`).join("")}</div>` : ""}
      <label class="field"><span>${albums.length ? "Ou crée un nouvel album" : "Nom du nouvel album"}</span><input class="input" name="n" placeholder="Vacances d'été"></label>`,
    actions: [{ label: "Annuler", cls: "ghost" }, { label: "Créer l'album", cls: "primary", primary: true, onClick: async (m) => {
      const n = $("[name=n]", m).value.trim(); if (!n) { toast("Donne un nom à l'album", "error"); return false; }
      return (await post("/api/albums", { name: n, photos: ids })).id; } }],
    onOpen: (m) => m.addEventListener("click", async (e) => { const a = e.target.closest("[data-a]"); if (!a) return; await post(`/api/albums/${a.dataset.a}/photos`, { photos: ids }); m.querySelector("[data-close]").click(); toast("Ajouté à l'album", "success"); }),
  });
  if (r) toast("Album créé", "success", { label: "Voir", onClick: () => window.NAS.navigate(`/albums/${r}`) });
  return r;
}

async function renderMap(el) {
  const box = $("#ph", el);
  box.innerHTML = `<div id="map"></div>`;
  if (!window.L) await new Promise((res) => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/static/vendor/leaflet.css"; document.head.append(l); const s = document.createElement("script"); s.src = "/static/vendor/leaflet.js"; s.onload = res; document.head.append(s); });
  const pts = await get("/api/photos/map");
  const map = L.map("map", { worldCopyJump: true, zoomControl: false }).setView([46.6, 2.4], 5);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { attribution: "© OpenStreetMap, © CARTO", maxZoom: 19 }).addTo(map);
  window.NAS.cleanup.push(() => map.remove());
  if (!pts.length) return L.popup().setLatLng([46.6, 2.4]).setContent("Aucune photo géolocalisée pour l'instant.").openOn(map);
  const layer = L.layerGroup().addTo(map);
  const redraw = () => {
    layer.clearLayers();
    const z = map.getZoom(), cell = 360 / Math.pow(2, z) / 4, groups = new Map();
    for (const p of pts) { const k = Math.round(p.lat / cell) + ":" + Math.round(p.lon / cell); (groups.get(k) || groups.set(k, []).get(k)).push(p); }
    for (const g of groups.values()) {
      const p = g[0], n = g.length;
      const ic = L.divIcon({ className: "", iconSize: [56, 56], html: `<div style="width:56px;height:56px;border-radius:14px;overflow:hidden;border:3px solid #fff;box-shadow:0 6px 18px #000a;position:relative"><img src="/api/photos/${p.id}/thumb" style="width:100%;height:100%;object-fit:cover">${n > 1 ? `<span style="position:absolute;right:-1px;top:-1px;background:#F28A12;color:#111;font:700 11px Inter,sans-serif;border-radius:0 0 0 8px;padding:1px 6px">${n}</span>` : ""}</div>` });
      L.marker([p.lat, p.lon], { icon: ic }).addTo(layer).on("click", () => (n === 1 || z >= 16) ? openViewer(g.map((x) => ({ ...x, video: !!x.video })), 0) : map.fitBounds(L.latLngBounds(g.map((x) => [x.lat, x.lon])).pad(0.3)));
    }
  };
  map.on("zoomend", redraw);
  map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.1), { maxZoom: 12 });
  redraw();
}

async function backup(files, el) {
  if (!files.length) return;
  const m = document.createElement("div"); m.className = "uploads"; document.body.append(m);
  const st = { done: 0, dup: 0, err: 0, bytes: 0, total: files.reduce((a, f) => a + f.size, 0), cancel: false };
  const drawP = (cur, p = 0) => {
    const pct = (st.bytes + (cur ? cur.size * p : 0)) / Math.max(1, st.total);
    m.innerHTML = `<header>${cur ? ring(pct) : `<span class="ok">${icon("circle-check")}</span>`}<span class="grow">${cur ? `Sauvegarde · ${st.done + st.dup + st.err + 1} sur ${files.length}` : "Sauvegarde terminée"}</span><button class="icon-btn" data-x>${icon("x")}</button></header>
      <div class="list2"><div class="item"><span class="fic k-image">${icon("images")}</span><div class="grow"><div>${st.done} nouvelle${st.done > 1 ? "s" : ""} · ${st.dup} déjà sauvegardée${st.dup > 1 ? "s" : ""}${st.err ? ` · <span class="err">${st.err} erreur(s)</span>` : ""}</div>
      <div class="faint small">${cur ? `${size(st.bytes)} sur ${size(st.total)} — garde l'app ouverte` : `${size(st.total)} vérifiés`}</div></div></div></div>`;
    paintIcons(m);
    m.querySelector("[data-x]").onclick = () => { st.cancel = true; m.remove(); };
  };
  drawP(files[0]);
  let known = new Set();
  try { known = new Set((await post("/api/photos/check", { items: files.map((f) => ({ name: f.name, size: f.size })) })).known); } catch {}
  let wake = null; try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  for (let i = 0; i < files.length && !st.cancel; i++) {
    const f = files[i];
    if (known.has(i)) { st.dup++; st.bytes += f.size; continue; }
    drawP(f);
    try { let last = 0; const r = await upload("/api/photos/backup?" + qs({ name: f.name, mtime: f.lastModified }), f, (p) => { if (Date.now() - last > 250) { last = Date.now(); drawP(f, p); } }); r.duplicate ? st.dup++ : st.done++; }
    catch { st.err++; }
    st.bytes += f.size;
  }
  try { wake?.release(); } catch {}
  drawP(null);
  setTimeout(() => m.remove(), 8000);
  if (location.pathname === "/photos") renderTimeline(el);
}

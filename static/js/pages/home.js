// Accueil : actions rapides, récents, dossiers partagés, dernières photos (façon iCloud.com).
import { get, qs, esc, icon, paintIcons, ago, vkind, fileIcon, shareLabel, folderUrl } from "../ui.js";
import { pick } from "../uploader.js";
import { openViewer } from "./photos.js";

const COLORS = ["o", "b", "g", "p", "pk", "t", "y"];
const colorOf = (s) => COLORS[[...s.name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

export default async function (el) {
  const me = window.NAS.me;
  const [recent, shares, photos] = await Promise.all([get("/api/recent?limit=12").catch(() => []), get("/api/shares"), get("/api/photos/timeline?limit=16").catch(() => ({ items: [] }))]);
  const h = new Date().getHours();
  const hello = h < 5 ? "Bonne nuit" : h < 18 ? "Bonjour" : "Bonsoir";
  const common = shares.filter((s) => s.kind === "standard");
  const qa = [
    ["upload", "o", "Importer", "Des fichiers vers Mes fichiers", "up"],
    ["send", "p", "Transférer", "Envoyer de gros fichiers par lien", "/transferts"],
    ["smartphone", "g", "Sauvegarder", "Les photos du téléphone, automatiquement", "/synchro?app=1"],
    ["inbox", "b", "Recevoir", "Des fichiers de quelqu'un", "/transferts?tab=demandes"],
  ];
  el.innerHTML = `<div class="hero"><h1>${hello} ${esc(me.display_name)}</h1><p>${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</p></div>
    ${!me.https ? `<div class="card row" style="margin-bottom:18px;border-color:var(--accent-line);background:linear-gradient(90deg,rgba(242,138,18,.08),transparent)">${icon("shield-alert")}<span class="grow small">Connexion non chiffrée. Une fois le HTTPS activé, ouvre <b>${location.host}</b> pour installer l'app et recevoir les notifications.</span></div>` : ""}
    ${me.active_alerts ? `<a class="card row" href="/admin" data-link style="margin-bottom:18px;border-color:rgba(248,113,113,.35);color:var(--text);text-decoration:none">${icon("circle-alert")}<b class="grow">${me.active_alerts} alerte(s) sur le NAS</b>${icon("chevron-right")}</a>` : ""}
    <div class="quick">${qa.map(([ic, c, t, s, to]) => `<button class="qa" data-to="${to}"><div class="qi ${c}">${icon(ic)}</div><div><b>${t}</b><span>${s}</span></div></button>`).join("")}</div>
    ${recent.length ? `<div class="section-title"><span class="grow">Récents</span><a href="/recents" data-link>Tout afficher</a></div>
      <div class="tiles home-recent">${recent.slice(0, 8).map((it, i) => { const k = vkind(it); return `<div class="tile" data-r="${i}" style="cursor:pointer"><div class="tname">${icon(fileIcon(k), "ti k-" + k)}<span>${esc(it.name)}</span></div>
        <div class="prev k-${k}">${icon(fileIcon(k))}${(it.kind === "image" || it.kind === "video") ? `<img loading="lazy" src="/api/files/thumb?${qs({ share: it.share, path: it.path })}" data-fb>` : ""}</div>
        <div class="faint small ellipsis" style="padding:8px 4px 2px">${esc(shareLabel(it))} · ${ago(it.at)}</div></div>`; }).join("")}</div>` : ""}
    ${common.length ? `<div class="section-title"><span class="grow">Dossiers partagés</span><a href="/partages" data-link>Tout afficher</a></div>
      <div class="share-cards">${common.slice(0, 6).map((s) => `<a class="scard" href="/fichiers?s=${s.id}" data-link><div class="si qi ${colorOf(s)}">${icon(s.icon || "folder")}</div><b>${esc(s.name)}</b><div class="desc">${esc(s.description || "")}</div><span class="chev">${icon("chevron-right")}</span></a>`).join("")}</div>` : ""}
    ${photos.items.length ? `<div class="section-title"><span class="grow">Dernières photos</span><a href="/photos" data-link>Toutes les photos</a></div>
      <div class="strip">${photos.items.slice(0, 16).map((p, i) => `<div class="ph" data-p="${i}"><img loading="lazy" src="/api/photos/${p.id}/thumb" alt=""></div>`).join("")}</div>` : ""}
    ${!recent.length && !photos.items.length ? `<div class="card" style="margin-top:28px;padding:32px;text-align:center"><div class="qi o" style="width:64px;height:64px;border-radius:20px;display:grid;place-items:center;margin:0 auto 14px">${icon("sparkles")}</div>
      <h3 style="justify-content:center;font-size:18px">Ton cloud est prêt</h3><p class="muted" style="max-width:440px;margin:0 auto 18px">Commence par importer quelques fichiers ou sauvegarder les photos de ton téléphone. Tout reste à la maison.</p>
      <button class="btn primary" data-to="up">${icon("upload")}Importer des fichiers</button></div>` : ""}`;
  paintIcons(el);
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-to]")?.dataset.to;
    if (t === "up") return pick(false);
    if (t) return window.NAS.navigate(t);
    const r = e.target.closest("[data-r]");
    if (r) { const it = recent[+r.dataset.r]; const parent = it.path.split("/").slice(0, -1).join("/"); return window.NAS.navigate(folderUrl(it, parent, it.name)); }
    const p = e.target.closest("[data-p]"); if (p) openViewer(photos.items, +p.dataset.p);
  });
}

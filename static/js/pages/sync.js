// Synchronisation : PC Windows (façon OneDrive) et photos des téléphones Android (façon Google Photos), via Syncthing.
import { get, post, api, del, esc, icon, paintIcons, $, $$, size, ago, toast, fail, modal, confirmBox, promptBox, menu, copy } from "../ui.js";

const KIND = {
  pc: { icon: "monitor", label: "PC Windows", short: "PC", le: "le PC", ton: "ton PC" },
  phone: { icon: "smartphone", label: "Téléphone Android", short: "téléphone", le: "le téléphone", ton: "ton téléphone" },
};
const PLAY = "https://play.google.com/store/search?q=syncthing-fork&c=apps";
const FDROID = "https://search.f-droid.org/?q=syncthing-fork&lang=fr";
const DL = "https://syncthing.net/downloads/";
const WZ_KEY = "arche-sync-wizard";

let data = null;

/** Minuteur sûr : jamais deux requêtes en même temps, en pause quand l'app est en arrière-plan. */
function poller(fn, ms) {
  let busy = false;
  const id = setInterval(async () => {
    if (busy || document.visibilityState !== "visible") return;
    busy = true; try { await fn(); } catch {} finally { busy = false; }
  }, ms);
  return () => clearInterval(id);
}
// L'assistant se souvient où il en est : Android ferme souvent Arche quand on passe dans Syncthing-Fork.
const wzLoad = () => { try { const w = JSON.parse(localStorage.getItem(WZ_KEY)); return w && Date.now() - w.t < 3 * 3600e3 ? w : null; } catch { return null; } };
const wzSave = (w) => { try { localStorage.setItem(WZ_KEY, JSON.stringify({ ...w, t: Date.now() })); } catch {} };
const wzClear = () => { try { localStorage.removeItem(WZ_KEY); } catch {} };

export default async function (el, { query }) {
  [data, apps] = await Promise.all([get("/api/sync"), get("/api/app/devices").catch(() => [])]);
  draw(el);
  const stop = poller(async () => {
    if ($(".modal-back")) return;
    [data, apps] = await Promise.all([get("/api/sync"), get("/api/app/devices").catch(() => apps)]);
    draw(el);
  }, 8000);
  window.NAS.cleanup.push(stop);
  if (inApp()) {
    const stop2 = poller(async () => drawPhone(el), 2000);
    const onEvt = () => { phone.albums = null; drawPhone(el); };
    window.addEventListener("archeapp", onEvt);
    window.NAS.cleanup.push(stop2, () => window.removeEventListener("archeapp", onEvt));
  }
  el.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]"); if (add) return add.dataset.add === "phone" ? installApp() : wizard(add.dataset.add, el);
    const m = e.target.closest("[data-dev-more]"); if (m) return devMenu(m, data.devices.find((d) => d.id === m.dataset.devMore), el);
    const am = e.target.closest("[data-app-more]"); if (am) return appMenu(am, apps.find((x) => String(x.id) === am.dataset.appMore), el);
    const st = e.target.closest("[data-steps]"); if (st) return wizard(st.dataset.steps, el, data.devices.find((d) => d.id === st.dataset.dev));
    phoneClick(e, el);
  });
  el.addEventListener("change", (e) => phoneChange(e, el));
  const k = query.get("add"), wantApp = query.get("app");
  if (k || wantApp) history.replaceState(history.state, "", "/synchro");   // un rechargement ne relance pas l'assistant
  const saved = wzLoad();
  if (wantApp && !inApp()) setTimeout(installApp, 150);
  else if (k === "pc") setTimeout(() => wizard("pc", el), 150);
  else if (saved?.kind === "pc") setTimeout(() => wizard("pc", el), 150);  // retour pendant l'assistant PC : on reprend
}

const inApp = () => !!window.ArcheApp;
let apps = [];

// ------------------------------------------------------------------ rendu
function draw(el) {
  const devs = data.devices;
  const totals = devs.flatMap((d) => d.folders).reduce((a, f) => ({ files: a.files + f.files, bytes: a.bytes + f.bytes }), { files: 0, bytes: 0 });
  const app = esc(window.NAS.me.app_name);
  const keepPhone = $("#sy-phone", el);
  el.innerHTML = `<div class="page-header"><div class="titles"><h1>Synchronisation</h1>
      <p>Tes photos et tes PC sauvegardés tout seuls sur ${app}, comme Google Photos et OneDrive.</p></div></div>
    ${inApp() ? `<div id="sy-phone"></div>` : ""}
    <div class="sy-add">
      ${inApp() ? "" : `<button class="sy-card" data-add="phone"><div class="qi g">${icon("smartphone")}</div><div><b>Sauvegarder un téléphone Android</b>
        <span>Installe l'app ${app} : chaque photo est sauvegardée toute seule, même celles de WhatsApp. Rien d'autre à installer.</span></div>${icon("chevron-right", "chev-r")}</button>`}
      <button class="sy-card" data-add="pc"><div class="qi b">${icon("monitor")}</div><div><b>Synchroniser un PC Windows</b>
        <span>Documents, Bureau, Images… copiés en continu, dans les deux sens. Même des centaines de Go.</span></div>${icon("chevron-right", "chev-r")}</button>
    </div>
    ${apps.length || devs.length ? `<div class="section-title"><span class="grow">Mes appareils</span>${totals.files ? `<span class="faint small" style="font-weight:500">PC : ${totals.files.toLocaleString("fr-FR")} fichiers · ${size(totals.bytes)}</span>` : ""}</div>
      <div class="sy-devs">${apps.map(appHtml).join("")}${devs.map(devHtml).join("")}</div>`
      : `<div class="card sy-empty">${icon("folder-sync")}<h3>Aucun appareil pour l'instant</h3><p class="muted">Choisis ci-dessus ce que tu veux sauvegarder.</p></div>`}
    <details class="card sy-faq"><summary>${icon("circle-help")}Questions fréquentes</summary>
      <p><b>Et quand je ne suis pas à la maison ?</b> La sauvegarde continue partout (4G, autre Wi-Fi), de façon chiffrée. À la maison, c'est simplement plus rapide. Dans l'app, tu peux choisir « seulement en Wi-Fi ».</p>
      <p><b>Où vont mes photos ?</b> Dans <a href="/photos" data-link>Photos</a>, et dans <a href="/fichiers" data-link>Mes fichiers</a> › <i>Photos</i> (rangées par année et par mois ; les captures et WhatsApp dans leur propre dossier). Toi seul y as accès.</p>
      <p><b>Si je supprime une photo sur mon téléphone ?</b> Elle reste sur ${app}. Tu peux donc libérer de la place sur le téléphone.</p>
      <p><b>Et les doublons ?</b> Une photo déjà sur ${app} (même envoyée autrement) n'est jamais renvoyée ni dupliquée.</p>
      <p><b>Si je supprime un fichier sur mon PC ?</b> Il disparaît aussi ici, mais une copie est gardée 30 jours dans la corbeille de synchro du NAS.</p></details>`;
  if (keepPhone && $("#sy-phone", el)) $("#sy-phone", el).replaceWith(keepPhone);
  else if (inApp()) drawPhone(el);
  paintIcons(el);
}

function appHtml(x) {
  const s = x.stats || {}, live = x.last_seen && Date.now() / 1000 - x.last_seen < 1800;
  const status = !s.enabled ? `<span class="tag yellow">Sauvegarde désactivée</span>`
    : s.running || s.pending > 0 ? `<span class="tag blue">${icon("refresh-cw", "spin-slow")}${s.pending ? `${s.pending.toLocaleString("fr-FR")}<span class="hide-m"> en attente</span>` : "En cours"}</span>`
    : `<span class="tag green"><span class="dot ok"></span>À jour</span>`;
  const line = s.on_phone != null ? `${(s.backed_up || 0).toLocaleString("fr-FR")} / ${s.on_phone.toLocaleString("fr-FR")} photos et vidéos sauvegardées` : "Pas encore de sauvegarde";
  return `<div class="card sy-dev">
    <div class="sy-dh"><div class="qi g">${icon("smartphone")}</div>
      <div class="grow"><b>${esc(x.name)}</b><span>${x.this ? "Ce téléphone · " : ""}App ${esc(x.app_version || "")}<span class="hide-m">${x.last_backup ? ` · dernière sauvegarde ${ago(x.last_backup)}` : ""}</span>${!live && x.last_seen ? ` · vu ${ago(x.last_seen)}` : ""}</span></div>
      ${status}<button class="icon-btn" data-app-more="${x.id}" aria-label="Options">${icon("ellipsis-vertical")}</button></div>
    <a class="sy-f" href="/photos" data-link><span class="fic k-image">${icon("images")}</span><div class="grow"><b>Photos</b><span>${line}${s.albums ? ` · ${s.albums} album${s.albums > 1 ? "s" : ""}` : ""}</span></div>${icon("chevron-right", "chev-r")}</a>
  </div>`;
}

function appMenu(btn, x, el) {
  menu(btn, [{ icon: "unlink", label: "Déconnecter ce téléphone", danger: true, onClick: async () => {
    if (!await confirmBox("Déconnecter ce téléphone ?", `<b>${esc(x.name)}</b> arrêtera de sauvegarder ses photos. <b>Les photos déjà sauvegardées restent</b> sur ${esc(window.NAS.me.app_name)}.`, { danger: true, ok: "Déconnecter" })) return;
    try { await del(`/api/app/devices/${x.id}`); if (x.this) window.ArcheApp?.unpair(); toast("Téléphone déconnecté", "success"); apps = await get("/api/app/devices"); draw(el); } catch (e) { fail(e); }
  } }]);
}

// ------------------------------------------------------------------ installation de l'app (depuis un navigateur)
async function installApp() {
  const android = /Android/i.test(navigator.userAgent), app = esc(window.NAS.me.app_name);
  let m = null; try { m = await get("/api/app/android"); } catch {}
  const steps = `<ol class="wz-ol big">
      <li>${android ? "Touche <b>Télécharger l'app</b> ci-dessus." : "Scanne ce code avec l'appareil photo de ton téléphone Android : l'app se télécharge."}</li>
      <li>Ouvre le fichier <b>${app}-${esc(m?.version_name || "")}.apk</b> (dans la notification de téléchargement). Android demande d'<b>autoriser l'installation</b> depuis ton navigateur : accepte, puis <b>Installer</b>.</li>
      <li>Ouvre <b>${app}</b> et connecte-toi comme d'habitude.</li>
      <li>Va dans <b>Plus › Synchronisation</b> et touche <b>Activer la sauvegarde</b>. C'est tout : tes photos partent toutes seules.</li></ol>
    <p class="faint small">L'app n'est pas sur le Play Store, c'est normal qu'Android affiche un avertissement. Si Play Protect propose de l'analyser, accepte. Les mises à jour se feront depuis l'app elle-même.</p>`;
  modal({ title: `Installer l'app ${app}`, wide: true, body: !m ? `<p>L'app n'est pas encore disponible. Réessaie un peu plus tard.</p>`
    : android ? `<div class="inst-hero">${icon("smartphone")}<div><b>${app} pour Android</b><span>Version ${esc(m.version_name)} · ${size(m.size)}</span></div></div>
        <a class="btn primary lg block" href="/api/app/android.apk" download>${icon("download")}Télécharger l'app</a>${steps}`
    : `<div class="inst-qr"><img src="/api/app/android/qr" alt="QR code de téléchargement" width="200" height="200"><div><b>${app} pour Android</b><span>Version ${esc(m.version_name)} · ${size(m.size)}</span>
        <a class="btn sm" href="/api/app/android.apk" download style="margin-top:10px">${icon("download")}Télécharger le fichier</a></div></div>${steps}`,
    actions: [{ label: "Fermer", cls: "primary", value: true }] });
}

// ------------------------------------------------------------------ ce téléphone (dans l'app)
const phone = { albums: null, showAll: false };
const nativeState = () => { try { return JSON.parse(window.ArcheApp.state()); } catch { return {}; } };

function drawPhone(el) {
  const box = $("#sy-phone", el); if (!box || !inApp()) return;
  const s = nativeState(), st = s.stats || {}, app = esc(window.NAS.me.app_name);
  if (s.enabled && s.permission !== "denied" && !phone.albums) { try { phone.albums = JSON.parse(window.ArcheApp.albums()); } catch { phone.albums = []; } }
  const total = st.on_phone || 0, done = st.backed_up || 0, pending = st.pending || 0, pct = total ? Math.round(done / total * 100) : 0;
  let head;
  if (!s.paired) head = `<div class="wz-wait"><div class="spinner"></div><div><b>Connexion de l'app…</b><span>Un instant.</span></div></div>`;
  else if (!s.enabled) head = `<div class="me-off"><p>Active la sauvegarde : toutes les photos et vidéos de ce téléphone seront copiées sur ${app}, puis chaque nouvelle photo, toute seule. Même si tu les supprimes du téléphone, elles restent ici.</p>
      <button class="btn primary lg block" data-ph="enable">${icon("cloud-upload")}Activer la sauvegarde automatique</button></div>`;
  else {
    const state = s.permission === "denied" ? ["triangle-alert", "red", "Accès aux photos refusé", "Autorise l'accès pour que la sauvegarde fonctionne."]
      : st.waiting === "wifi" && pending ? ["wifi-off", "yellow", "En attente du Wi-Fi", `${pending.toLocaleString("fr-FR")} photo${pending > 1 ? "s" : ""} à envoyer dès que tu seras en Wi-Fi.`]
      : st.waiting === "charge" && pending ? ["battery-charging", "yellow", "En attente de la charge", `${pending.toLocaleString("fr-FR")} photo${pending > 1 ? "s" : ""} à envoyer quand le téléphone sera branché.`]
      : s.running || st.running ? ["refresh-cw", "blue", "Sauvegarde en cours…", `${pending.toLocaleString("fr-FR")} restante${pending > 1 ? "s" : ""}`]
      : pending ? ["clock", "blue", "Sauvegarde bientôt", `${pending.toLocaleString("fr-FR")} en attente`]
      : st.on_phone != null ? ["circle-check", "green", "Tout est sauvegardé", `${done.toLocaleString("fr-FR")} photos et vidéos`]
      : ["refresh-cw", "blue", "Première analyse…", "Recherche des photos du téléphone"];
    head = `<div class="me-st ${state[1]}">${icon(state[0], state[0] === "refresh-cw" ? "spin-slow" : "")}<div class="grow"><b>${state[2]}</b><span>${state[3]}${s.last_backup ? ` · dernière sauvegarde ${ago(s.last_backup)}` : ""}</span></div></div>
      ${total ? `<div class="me-bar"><i style="width:${pct}%"></i></div><div class="me-sub"><span>${done.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")}</span><span>${pct} %</span></div>` : ""}
      <button class="btn block" data-ph="now">${icon("refresh-cw")}Sauvegarder maintenant</button>`;
  }
  const warn = [];
  if (s.enabled) {
    if (s.permission === "denied") warn.push(["image-off", "L'app n'a pas accès à tes photos.", "Autoriser", "perms"]);
    if (s.permission === "partial") warn.push(["image-off", "L'app n'a accès qu'à une partie de tes photos.", "Tout autoriser", "settings"]);
    if (!s.battery) warn.push(["battery-warning", "Android peut mettre la sauvegarde en pause quand l'app est fermée.", "Autoriser en arrière-plan", "battery"]);
    if (/xiaomi|redmi|poco/i.test(s.manufacturer || "")) warn.push(["rocket", "Xiaomi : dans les réglages de l'app, active aussi « Démarrage automatique » et « Économiseur de batterie : Aucune restriction ».", "Ouvrir les réglages", "settings"]);
    if (!s.location) warn.push(["map-pin-off", "Le lieu des photos ne sera pas conservé (carte des photos).", "Autoriser", "perms"]);
    if (!s.notifications) warn.push(["bell-off", "Notifications désactivées : tu ne verras pas la progression ni les nouveautés.", "Autoriser", "perms"]);
  }
  const albums = phone.albums || [];
  const shown = phone.showAll ? albums : albums.filter((a) => a.enabled || a.suggested || a.count >= 20).slice(0, 12);
  const nOn = albums.filter((a) => a.enabled).length;
  box.innerHTML = `<section class="card sy-me">
    <div class="sy-dh" style="padding:0 0 12px"><div class="qi g">${icon("images")}</div><div class="grow"><b>Photos de ce téléphone</b><span>${esc(window.ArcheApp.deviceName())} · app ${esc(s.version || "")}</span></div></div>
    ${head}
    ${warn.map(([ic, t, b, a]) => `<div class="me-warn">${icon(ic)}<span class="grow">${t}</span><button class="btn sm" data-ph="${a}">${b}</button></div>`).join("")}
    ${s.enabled && albums.length ? `<div class="me-h"><b>Albums sauvegardés</b><span class="faint small">${nOn} sur ${albums.length}</span><span class="grow"></span><button class="btn ghost sm" data-ph="all">Tout</button></div>
      <div class="me-albums">${shown.map((a) => `<label class="me-al"><span class="th">${a.thumb ? `<img src="${a.thumb}" alt="">` : icon("image")}</span>
        <span class="grow"><b>${esc(a.name)}</b><span>${a.count.toLocaleString("fr-FR")} · ${esc(a.path || "")}</span></span>
        <span class="switch"><input type="checkbox" data-album="${esc(a.id)}" ${a.enabled ? "checked" : ""}><span class="track"></span></span></label>`).join("")}</div>
      ${albums.length > shown.length ? `<button class="btn ghost sm block" data-ph="more">Voir les ${albums.length - shown.length} autres albums</button>` : ""}` : ""}
    ${s.enabled ? `<div class="me-h"><b>Options</b></div><div class="me-opts">
      ${[["wifi_only", "Seulement en Wi-Fi", "Pour ne pas utiliser les données mobiles"], ["charging_only", "Seulement en charge", "Économise la batterie (la sauvegarde attend que le téléphone soit branché)"],
         ["videos", "Sauvegarder les vidéos", "Les grosses vidéos sont envoyées par morceaux"], ["include_existing", "Photos déjà sur le téléphone", "Sinon, seules les nouvelles photos sont sauvegardées"]]
        .map(([k, t, d]) => `<label class="me-opt"><span class="grow"><b>${t}</b><span>${d}</span></span><span class="switch"><input type="checkbox" data-opt="${k}" ${s[k] ? "checked" : ""}><span class="track"></span></span></label>`).join("")}</div>` : ""}
    <div class="me-foot"><button class="btn ghost sm" data-ph="update">${icon("download")}Mises à jour</button>${s.enabled ? `<button class="btn ghost sm" data-ph="off">${icon("pause")}Désactiver</button>` : ""}</div>
  </section>`;
  paintIcons(box);
}

function phoneClick(e, el) {
  const b = e.target.closest("[data-ph]"); if (!b || !inApp()) return;
  const A = window.ArcheApp, a = b.dataset.ph;
  if (a === "enable") { A.setEnabled(true); phone.albums = null; }
  else if (a === "now") { A.backupNow(); toast("Sauvegarde lancée", "success"); }
  else if (a === "perms") A.requestPermissions();
  else if (a === "settings") A.openAppSettings();
  else if (a === "battery") A.openBattery();
  else if (a === "more") phone.showAll = true;
  else if (a === "all") { const on = (phone.albums || []).some((x) => !x.enabled); A.setAllAlbums(on); phone.albums = null; }
  else if (a === "update") { A.installUpdate(); toast("Recherche d'une mise à jour…"); }
  else if (a === "off") { A.setEnabled(false); }
  setTimeout(() => drawPhone(el), 150);
}

function phoneChange(e, el) {
  if (!inApp()) return;
  const al = e.target.dataset.album, op = e.target.dataset.opt;
  if (al) { window.ArcheApp.setAlbum(al, e.target.checked); const x = (phone.albums || []).find((a) => a.id === al); if (x) x.enabled = e.target.checked; }
  if (op) { window.ArcheApp.setOption(op, e.target.checked); if (op === "videos") phone.albums = null; }
  setTimeout(() => drawPhone(el), 150);
}

function devHtml(d) {
  const k = KIND[d.kind];
  const syncing = d.folders.some((f) => f.need_bytes > 0 || f.state === "syncing" || (d.connected && f.remote_completion != null && f.remote_completion < 100));
  const status = d.connected ? (syncing ? `<span class="tag blue">${icon("refresh-cw", "spin-slow")}<span class="hide-m">Synchronisation…</span><span class="show-m">Synchro…</span></span>` : `<span class="tag green"><span class="dot ok"></span>À jour</span>`)
    : d.last_seen ? `<span class="tag">Vu ${ago(d.last_seen)}</span>` : `<span class="tag yellow">Jamais connecté</span>`;
  return `<div class="card sy-dev">
    <div class="sy-dh"><div class="qi ${d.kind === "pc" ? "b" : "g"}">${icon(k.icon)}</div>
      <div class="grow"><b>${esc(d.name)}</b><span>${esc(k.label)}<span class="hide-m">${d.connected ? ` · ${d.relay ? "via relais" : "connexion directe"}` : ""}</span></span></div>
      ${status}<button class="icon-btn" data-dev-more="${esc(d.id)}" aria-label="Options">${icon("ellipsis-vertical")}</button></div>
    ${waitHint(d)}${d.folders.length ? `<div class="sy-folders">${d.folders.map((f) => folderHtml(f, d)).join("")}</div>`
      : `<div class="sy-hint">${icon("info")}<span class="grow">${d.connected ? `Connecté ! Il reste à choisir ${d.kind === "pc" ? "les dossiers à synchroniser" : "le dossier de l'appareil photo"} dans Syncthing.` : `En attente de la première connexion. Vérifie que Syncthing est ouvert sur ${d.kind === "pc" ? "le PC" : "le téléphone"}.`}</span>
        <button class="btn sm" data-steps="${d.kind}" data-dev="${esc(d.id)}">Voir les étapes</button></div>`}
  </div>`;
}

const pendingOffer = (d) => d.folders.find((f) => f.offered && f.remote_state !== "valid" && !f.files);
function waitHint(d) {
  if (!pendingOffer(d)) return "";
  return `<div class="sy-hint warn">${icon("hand")}<span class="grow">Dernière étape : sur ${KIND[d.kind].le}, ouvre Syncthing-Fork et <b>accepte le dossier « Appareil photo »</b> en choisissant <b>DCIM › Camera</b>.</span>
    <button class="btn sm primary" data-steps="${d.kind}" data-dev="${esc(d.id)}">Continuer</button></div>`;
}

function folderHtml(f, d) {
  const url = `/fichiers?p=${encodeURIComponent(f.relpath)}`;
  const st = f.offered && f.remote_state !== "valid" && !f.files ? `<span class="tag yellow">À accepter</span>` : f.errors ? `<span class="tag red">${icon("triangle-alert")}${f.errors} erreur${f.errors > 1 ? "s" : ""}</span>`
    : f.need_bytes > 0 ? `<span class="tag blue">Reste ${size(f.need_bytes)}</span>`
    : f.state === "scanning" ? `<span class="tag">Analyse…</span>`
    : d.connected && f.remote_completion != null && f.remote_completion < 100 ? `<span class="tag blue">${Math.floor(f.remote_completion)} %</span>` : "";
  return `<a class="sy-f" href="${url}" data-link><span class="fic ${f.kind === "phone" ? "k-image" : "k-folder"}">${icon(f.kind === "phone" ? "camera" : "folder")}</span>
    <div class="grow"><b>${esc(f.label)}</b><span>${f.files.toLocaleString("fr-FR")} fichiers · ${size(f.bytes)}<span class="hide-m"> · Mes fichiers › ${esc(f.relpath.split("/").join(" › "))}</span></span></div>${st}${icon("chevron-right", "chev-r")}</a>`;
}

function devMenu(btn, d, el) {
  menu(btn, [
    { icon: "list-checks", label: "Revoir les étapes", onClick: () => wizard(d.kind, el, d) },
    { icon: "pencil", label: "Renommer", onClick: async () => {
      const n = await promptBox("Renommer l'appareil", "Nom", d.name, { ok: "Renommer" }); if (!n) return;
      try { await api(`/api/sync/devices/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { name: n } }); refresh(el); } catch (e) { fail(e); } } },
    "-",
    { icon: "unlink", label: "Arrêter la synchro de cet appareil", danger: true, onClick: async () => {
      if (!await confirmBox("Arrêter la synchro ?", `<b>${esc(d.name)}</b> ne sera plus synchronisé. <b>Les fichiers déjà sauvegardés restent</b> dans Mes fichiers, rien n'est effacé, ni ici ni sur l'appareil.`, { danger: true, ok: "Arrêter" })) return;
      try { await del(`/api/sync/devices/${encodeURIComponent(d.id)}`); toast("Synchro arrêtée, fichiers conservés", "success"); refresh(el); } catch (e) { fail(e); } } },
  ]);
}
async function refresh(el) { data = await get("/api/sync"); draw(el); }

// ------------------------------------------------------------------ assistant
function wizard(kind, el, existing) {
  if ($(".modal-back")) return;
  const pc = kind === "pc", K = KIND[kind], app = esc(window.NAS.me.app_name), idTxt = esc(data.nas_id);
  const saved = wzLoad();
  // où reprendre ? 1) l'appareil demandé  2) l'étape mémorisée  3) un téléphone relié dont le dossier n'est pas encore accepté
  let dev = existing || (saved?.kind === kind ? saved.dev : null) || null;
  if (!dev && !pc) { const d = data.devices.find((x) => x.kind === "phone" && pendingOffer(x)); if (d) dev = { id: d.id, name: d.name, kind }; }
  let step = existing ? (existing.folders?.length || existing.connected ? 3 : 1) : saved?.kind === kind ? saved.step : dev ? 3 : 0;
  const since = saved?.since || Math.floor(Date.now() / 1000) - 60;
  let stop = () => {};
  const battery = `<div class="wz-note">${icon("battery-charging")}<div><b>Important pour que ça tourne en arrière-plan</b>
      <span>Dans les <b>Paramètres</b> du téléphone → <b>Applications</b> → <b>Syncthing-Fork</b> :<br>
      • <b>Batterie</b> (ou Économiseur de batterie) : <b>Aucune restriction</b> / <b>Non optimisée</b><br>
      • Sur Xiaomi, Redmi, Poco : active aussi <b>Démarrage automatique</b></span></div></div>`;
  const steps = pc ? [
    ["download", "Installe Syncthing sur le PC", `<p>Syncthing est un logiciel gratuit qui fait la synchro. Sur la page de téléchargement, prends <b>« Syncthing Windows Setup »</b> (section <i>Windows</i>) et installe-le avec les options par défaut.</p>
      <a class="btn primary" href="${DL}" target="_blank" rel="noopener">${icon("external-link")}Ouvrir la page de téléchargement</a>
      <p class="faint small" style="margin-top:12px">Ensuite, ouvre <b>« Syncthing Configuration Page »</b> depuis le menu Démarrer : l'écran de Syncthing s'ouvre dans ton navigateur.</p>`],
    ["link", `Relie le PC à ${app}`, `<p>Dans l'écran de Syncthing sur le PC : <b>+ Ajouter un appareil</b> (en bas à droite), colle cet identifiant :</p>
      ${idBox(idTxt)}<p>Nom : <b>${app}</b>, puis <b>Enregistrer</b>. Reviens ici : ${app} va le détecter.</p>`],
    ["badge-check", "Confirme que c'est ton PC", `<div id="wz-claim"></div>`],
    ["folder-plus", "Choisis les dossiers à sauvegarder", `<p>Dans Syncthing sur le PC : <b>+ Ajouter un dossier</b>, puis</p>
      <ol class="wz-ol"><li><b>Libellé</b> : un nom, par ex. <i>Documents</i></li><li><b>Chemin</b> : le dossier, par ex. <code>C:\Users\toi\Documents</code></li><li>Onglet <b>Partage</b> : coche <b>${app}</b></li><li><b>Enregistrer</b></li></ol>
      <p>Recommence pour <i>Bureau</i>, <i>Images</i>… Chaque dossier apparaît ci-dessous tout seul.</p><div id="wz-folders"></div>`],
  ] : [
    ["download", "Installe Syncthing-Fork", `<p>C'est l'app gratuite qui envoie tes photos à ${app}.</p>
      <div class="wz-btns"><a class="btn primary" href="${PLAY}" target="_blank" rel="noopener">${icon("external-link")}Play Store</a><a class="btn" href="${FDROID}" target="_blank" rel="noopener">${icon("external-link")}F-Droid</a></div>
      <p>Ouvre-la une première fois et <b>accepte toutes les autorisations</b> qu'elle demande (fichiers, photos, notifications).</p>${battery}`],
    ["link", `Relie le téléphone à ${app}`, `<p><b>1.</b> Copie l'identifiant de ${app} :</p>${idBox(idTxt)}
      <div class="wz-qr">${data.nas_qr}<span>…ou scanne ce QR code depuis Syncthing-Fork si tu es sur un ordinateur</span></div>
      <p><b>2.</b> Dans Syncthing-Fork : onglet <b>Appareils</b> → bouton <b>+</b> → colle-le dans <b>ID de l'appareil</b>, nom <b>${app}</b>, puis valide (✓ en haut à droite).</p>
      <p><b>3.</b> Reviens dans ${app} : l'assistant reprend tout seul.</p>`],
    ["badge-check", "Confirme que c'est ton téléphone", `<div id="wz-claim"></div>`],
    ["camera", "Accepte le dossier sur le téléphone", `<p>${app} vient d'envoyer à ton téléphone le dossier <b>« Appareil photo »</b>. Dans Syncthing-Fork :</p>
      <ol class="wz-ol"><li>Touche la notification <b>« ${app} veut partager le dossier Appareil photo »</b> (ou va dans l'onglet <b>Dossiers</b> : la demande est en haut)</li>
        <li>Touche <b>Accepter</b> / <b>Ajouter</b></li>
        <li>Dans <b>Répertoire</b>, choisis <b>DCIM</b> → <b>Camera</b> <span class="faint">(là où sont tes photos)</span></li><li>Valide (✓)</li></ol>
      <div id="wz-folders"></div>`],
  ];
  wzSave({ kind, step, dev, since });
  modal({
    title: pc ? "Synchroniser un PC Windows" : "Sauvegarder un téléphone Android", wide: true,
    body: `<div class="wz"><div class="wz-dots" id="wz-dots"></div><div id="wz-body"></div></div>`,
    actions: [{ label: "Retour", cls: "ghost", onClick: () => { if (step > 0) { step--; render(); } return false; } },
      { label: "Suivant", cls: "primary", onClick: () => { if (step < steps.length - 1) { if (step === 2 && !dev) { toast(`Confirme d'abord ${K.ton}.`, "error"); return false; } step++; render(); return false; } return true; } }],
    onOpen: (m) => { m.querySelector(".modal").classList.add("wz-modal"); window.__wz = m; render(); },
  }).then(() => { stop(); wzClear(); refresh(el).catch(() => {}); });

  function render() {
    const m = window.__wz, [ic, t, html] = steps[step];
    wzSave({ kind, step, dev, since });
    $("#wz-dots", m).innerHTML = steps.map((s, i) => `<span class="${i < step ? "done" : i === step ? "on" : ""}">${i < step ? icon("check") : i + 1}</span>`).join("<i></i>");
    $("#wz-body", m).innerHTML = `<div class="wz-step"><div class="qi ${pc ? "b" : "g"}">${icon(ic)}</div><h3>${t}</h3></div><div class="wz-txt">${html}</div>`;
    const [back, next] = m.querySelectorAll("footer .btn");
    back.style.visibility = step === 0 ? "hidden" : ""; next.textContent = step === steps.length - 1 ? "Terminer" : step === 1 ? "C'est fait" : "Suivant";
    paintIcons(m);
    $$("[data-copy]", m).forEach((b) => (b.onclick = () => { copy(b.dataset.copy); b.innerHTML = icon("check") + "Copié"; paintIcons(b); }));
    stop();
    if (step === 2) { drawClaim(); stop = poller(drawClaim, 3000); }
    if (step === 3) { drawFolders(); stop = poller(drawFolders, 3000); }
  }

  async function drawClaim() {
    const box = $("#wz-claim", window.__wz); if (!box) return;
    if (dev) { box.innerHTML = `<div class="wz-ok">${icon("circle-check")}<div><b>${esc(dev.name)} est relié à ${app}</b><span>Touche Suivant pour la dernière étape.</span></div></div>`; return paintIcons(box); }
    if (box.dataset.manual) return;                                   // la personne tape l'identifiant : on ne redessine pas
    const d = await get("/api/sync?since=" + since);
    if (!$("#wz-claim", window.__wz) || dev || box.dataset.manual) return;
    const pend = d.pending;
    box.innerHTML = (pend.length ? pend.map((p) => `<div class="wz-pend"><div class="qi ${pc ? "b" : "g"}">${icon(K.icon)}</div>
        <div class="grow"><b>« ${esc(p.name)} » veut se connecter</b><span>Identifiant ${esc(p.id.slice(0, 7))}… · ${ago(p.time)}</span></div>
        <button class="btn primary" data-claim="${esc(p.id)}" data-name="${esc(p.name)}">C'est ${K.ton}</button></div>`).join("")
      : `<div class="wz-wait"><div class="spinner"></div><div><b>En attente de ${K.ton}…</b><span>Dès que tu as ajouté ${app} dans Syncthing${pc ? "" : "-Fork"}, il apparaît ici. Laisse l'app ouverte quelques secondes.</span></div></div>`) +
      `<details class="wz-manual"><summary>Il n'apparaît pas ? Saisis son identifiant</summary>
        <p class="faint small">${pc ? "Dans Syncthing sur le PC : <b>Actions</b> (en haut à droite) → <b>Afficher l'ID</b>." : "Dans Syncthing-Fork : menu ☰ → <b>Afficher l'ID de l'appareil</b> (on peut le copier)."}</p>
        <label class="field"><span>Identifiant</span><input class="input mono" id="wz-id" placeholder="XXXXXXX-XXXXXXX-…" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
        <label class="field"><span>Nom</span><input class="input" id="wz-name" value="${pc ? "Mon PC" : "Mon téléphone"}"></label>
        <button class="btn" id="wz-add">${icon("plus")}Ajouter</button></details>`;
    paintIcons(box);
    box.querySelectorAll("[data-claim]").forEach((b) => (b.onclick = () => claim(b.dataset.claim, b.dataset.name)));
    const man = box.querySelector(".wz-manual");
    man.ontoggle = () => { box.dataset.manual = man.open ? "1" : ""; };
    $("#wz-add", box).onclick = () => claim($("#wz-id", box).value, $("#wz-name", box).value);
  }

  async function claim(id, name) {
    try {
      const r = await post("/api/sync/devices", { device_id: id, name, kind });
      dev = { id: r.id, name: r.name, kind }; navigator.vibrate?.(12); toast(`${r.name} relié`, "success");
      step = 3; render();
    } catch (e) { fail(e); }
  }

  async function drawFolders() {
    const box = $("#wz-folders", window.__wz); if (!box || !dev) return;
    const d = await get("/api/sync"); data = d;
    const me = d.devices.find((x) => x.id === dev.id); if (!me || !$("#wz-folders", window.__wz)) return;
    const conn = me.connected ? `<div class="wz-conn ok"><span class="dot ok"></span>${esc(me.name)} est connecté</div>`
      : `<div class="wz-conn"><span class="dot warn"></span>${esc(me.name)} n'est pas connecté : ouvre Syncthing-Fork${pc ? "" : " (et vérifie les réglages de batterie de l'étape 1)"}.</div>`;
    box.innerHTML = conn + (me.folders.length ? me.folders.map((f) => {
      const ok = !f.offered || f.remote_state === "valid" || f.files;
      return ok ? `<div class="wz-ok">${icon("circle-check")}<div><b>« ${esc(f.label)} » se synchronise</b><span>${f.files ? `${f.files.toLocaleString("fr-FR")} fichiers reçus · ${size(f.bytes)}` : "Accepté ! Les premiers fichiers arrivent…"} · Mes fichiers › ${esc(f.relpath.split("/").join(" › "))}</span></div></div>`
        : `<div class="wz-wait"><div class="spinner"></div><div><b>En attente de ton accord sur le téléphone…</b><span>Accepte « ${esc(f.label)} » dans Syncthing-Fork : dès que c'est fait, ça s'affiche ici.</span></div></div>`;
    }).join("") : `<div class="wz-wait"><div class="spinner"></div><div><b>En attente d'un dossier…</b><span>Ajoute un dossier dans Syncthing : il s'affichera ici.</span></div></div>`);
    paintIcons(box);
  }
}

const idBox = (id) => `<div class="wz-id"><code>${id}</code><button class="btn sm primary" data-copy="${id}">${icon("copy")}Copier</button></div>`;

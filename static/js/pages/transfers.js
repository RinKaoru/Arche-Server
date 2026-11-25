// Transferts façon WeTransfer : envoyer des fichiers par lien, demander des fichiers, gérer ses liens.
import { get, post, del, qs, upload, esc, icon, paintIcons, $, size, ago, date, toast, fail, confirmBox, copy, vkind, fileIcon, menu, shareLabel, isMine, publicLink } from "../ui.js";
import { shareResult } from "./files.js";

export default async function (el, { query, path }) {
  const tab = path === "/liens" ? "liens" : query.get("tab") || "envoyer";
  el.innerHTML = `<div class="page-header"><div class="titles"><h1>Transferts</h1><p>Envoie de gros fichiers par lien, ou reçois-en de n'importe qui, sans compte.</p></div>
    <div class="actions"><div class="seg"><button data-t="envoyer" class="${tab === "envoyer" ? "active" : ""}">${icon("send")}Envoyer</button><button data-t="demandes" class="${tab === "demandes" ? "active" : ""}">${icon("inbox")}Recevoir</button><button data-t="liens" class="${tab === "liens" ? "active" : ""}">${icon("link")}Liens</button></div></div></div><div id="x"></div>`;
  paintIcons(el);
  el.querySelector(".seg").onclick = (e) => { const b = e.target.closest("[data-t]"); if (b) window.NAS.navigate("/transferts" + (b.dataset.t === "envoyer" ? "" : "?tab=" + b.dataset.t), true); };
  const box = $("#x", el);
  if (tab === "demandes") return requests(box);
  if (tab === "liens") return links(box);
  return send(box);
}

// ------------------------------------------------------------------ envoyer
async function send(box) {
  let files = [];
  const history = await get("/api/transfers");
  box.innerHTML = `<div class="xfer"><div class="composer" id="cp"></div><div><div class="section-title" style="margin-top:4px"><span class="grow">Transferts envoyés</span></div><div id="hist"></div></div></div>`;
  const drawHist = (list) => {
    $("#hist", box).innerHTML = list.length ? `<div class="card pad0">${list.map((t) => `<div class="xitem" data-id="${t.id}" data-url="${esc(publicLink(t.url))}">
      <div class="xi qi ${t.expired ? "" : "p"}">${icon(t.expired ? "clock-alert" : "send")}</div>
      <div class="grow"><b class="ellipsis" style="display:block;font-weight:600">${esc(t.title || t.files[0]?.name || "Transfert")}</b>
        <span class="faint small">${t.count} fichier${t.count > 1 ? "s" : ""} · ${size(t.size)} · ${t.downloads} téléchargement${t.downloads > 1 ? "s" : ""} · ${t.expired ? "expiré" : "expire " + rel(t.expires_at)}</span></div>
      ${t.expired ? "" : `<button class="btn sm" data-copy>${icon("copy")}<span class="hide-m">Copier le lien</span></button>`}<button class="icon-btn" data-more>${icon("ellipsis-vertical")}</button></div>`).join("")}</div>`
      : `<div class="card center" style="padding:40px 20px"><div class="qi p" style="width:56px;height:56px;border-radius:18px;display:grid;place-items:center;margin:0 auto 12px">${icon("send")}</div><b>Aucun transfert pour l'instant</b><p class="muted small" style="margin:6px auto 0;max-width:320px">Ajoute des fichiers à gauche : tu obtiendras un lien à envoyer par message ou e-mail.</p></div>`;
    paintIcons($("#hist", box));
  };
  drawHist(history);
  $("#hist", box).onclick = async (e) => {
    const row = e.target.closest("[data-id]"); if (!row) return;
    if (e.target.closest("[data-copy]")) return copy(row.dataset.url);
    if (e.target.closest("[data-more]")) menu(e.target.closest("[data-more]"), [
      { icon: "external-link", label: "Ouvrir la page", onClick: () => window.open(row.dataset.url, "_blank") },
      { icon: "copy", label: "Copier le lien", onClick: () => copy(row.dataset.url) },
      "-",
      { icon: "trash-2", label: "Supprimer le transfert", danger: true, onClick: async () => { if (await confirmBox("Supprimer ce transfert ?", "Le lien ne fonctionnera plus et les fichiers envoyés seront effacés.", { danger: true, ok: "Supprimer" })) { await del(`/api/transfers/${row.dataset.id}`); drawHist(await get("/api/transfers")); } } },
    ]);
  };

  const cp = $("#cp", box);
  const drawComposer = () => {
    const total = files.reduce((a, f) => a + f.size, 0);
    cp.innerHTML = `<div class="add" id="add"><div class="plus">${icon("plus")}</div><div><b>${files.length ? "Ajouter d'autres fichiers" : "Ajoute tes fichiers"}</b><span>${files.length ? `${files.length} fichier${files.length > 1 ? "s" : ""} · ${size(total)}` : "Ou glisse-les ici · aucune limite de taille"}</span></div></div>
      ${files.length ? `<div class="flist">${files.map((f, i) => { const k = vkind({ name: f.name, kind: kindOf(f) }); return `<div class="fitem"><span class="fic k-${k}">${icon(fileIcon(k))}</span><div class="grow"><b>${esc(f.name)}</b><span>${size(f.size)}</span></div><button class="icon-btn" data-rm="${i}" title="Retirer">${icon("x")}</button></div>`; }).join("")}</div>` : ""}
      <div class="cbody"><input class="input" id="tt" placeholder="Titre (facultatif)" maxlength="120"><textarea class="input" id="tm" placeholder="Message (facultatif)"></textarea>
      <div class="opts"><span class="faint small">${icon("clock")}</span><select class="input" id="te"><option value="1">Expire dans 1 jour</option><option value="3">3 jours</option><option value="7" selected>7 jours</option><option value="30">30 jours</option></select>
      <button class="btn sm ghost" id="pwb">${icon("lock")}<span id="pwl">Mot de passe</span></button></div>
      <input class="input" id="tp" type="text" placeholder="Mot de passe du lien" hidden autocomplete="off">
      <button class="btn primary lg block" id="go" ${files.length ? "" : "disabled"} style="margin-top:6px">Transférer</button>
      <p class="faint small center" style="margin:12px 0 0">${icon("shield-check")} Lien privé et chiffré, accessible depuis Internet.</p></div>`;
    paintIcons(cp);
    $("#add", cp).onclick = () => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.onchange = () => { files.push(...i.files); drawComposer(); }; i.click(); };
    cp.querySelector(".flist")?.addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { files.splice(+b.dataset.rm, 1); drawComposer(); } });
    $("#pwb", cp).onclick = () => { const p = $("#tp", cp); p.hidden = !p.hidden; if (!p.hidden) p.focus(); };
    $("#go", cp).onclick = go;
    const add = $("#add", cp);
    cp.ondragover = (e) => { e.preventDefault(); add.classList.add("over"); };
    cp.ondragleave = () => add.classList.remove("over");
    cp.ondrop = (e) => { e.preventDefault(); files.push(...[...e.dataTransfer.files]); drawComposer(); };
  };
  const go = async () => {
    const title = $("#tt", cp).value, message = $("#tm", cp).value, exp = +$("#te", cp).value, pw = $("#tp", cp).value;
    let t;
    try { t = await post("/api/transfers", { title, message, expires_days: exp, password: pw }); } catch (e) { return fail(e); }
    const total = files.reduce((a, f) => a + f.size, 0); let sent = 0;
    const R = 2 * Math.PI * 56;
    const prog = (p) => { cp.innerHTML = `<div class="cbody center" style="padding:30px 22px"><div class="done-ring"><svg class="r" viewBox="0 0 128 128"><circle class="bg" cx="64" cy="64" r="56"/><circle class="fg" cx="64" cy="64" r="56" stroke-dasharray="${R}" stroke-dashoffset="${R * (1 - p)}"/></svg><div class="pct">${Math.round(p * 100)}%</div></div>
      <b style="font-size:17px">Transfert en cours…</b><p class="muted small">${size(sent)} sur ${size(total)}</p></div>`; };
    prog(0);
    for (const f of files) {
      try { await upload(`/api/transfers/${t.id}/upload?` + qs({ name: f.name }), f, (p) => prog((sent + f.size * p) / Math.max(1, total))); }
      catch (e) { fail(e); }
      sent += f.size;
    }
    const link = publicLink(t.url);
    cp.innerHTML = `<div class="cbody center" style="padding:30px 22px"><div class="done-ring"><svg class="r" viewBox="0 0 128 128"><circle class="bg" cx="64" cy="64" r="56"/><circle class="fg" cx="64" cy="64" r="56" stroke-dasharray="${R}" stroke-dashoffset="0" style="stroke:var(--green)"/></svg><div class="pct">${icon("check")}</div></div>
      <b style="font-size:19px;letter-spacing:-.02em">C'est envoyé !</b><p class="muted small" style="margin:6px 0 18px">Copie le lien et partage-le avec qui tu veux.</p>
      <div class="row" style="background:var(--panel);border:1px solid var(--line-2);border-radius:12px;padding:6px 6px 6px 14px;text-align:left"><span class="grow mono ellipsis">${esc(link)}</span><button class="btn primary sm" id="cpl">${icon("copy")}Copier</button></div>
      ${navigator.share ? `<button class="btn block" id="shr" style="margin-top:10px">${icon("share-2")}Envoyer via…</button>` : ""}
      <button class="btn ghost block" id="again" style="margin-top:10px">Nouveau transfert</button></div>`;
    paintIcons(cp);
    $("#cpl", cp).onclick = () => copy(link);
    $("#shr", cp) && ($("#shr", cp).onclick = () => navigator.share({ title: title || "Fichiers", url: link }).catch(() => {}));
    $("#again", cp).onclick = () => { files = []; drawComposer(); };
    drawHist(await get("/api/transfers"));
  };
  drawComposer();
}

const kindOf = (f) => f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : f.type === "application/pdf" ? "pdf" : "file";
function rel(ts) {
  const d = Math.round((ts - Date.now() / 1000) / 86400);
  return d <= 0 ? "aujourd'hui" : d === 1 ? "demain" : `dans ${d} jours`;
}

// ------------------------------------------------------------------ demandes de fichiers
async function requests(box) {
  const list = await get("/api/requests");
  const shares = (await get("/api/shares")).filter((s) => s.level === "write" && s.kind !== "timemachine" && (s.kind !== "personal" || isMine(s)));
  box.innerHTML = `<div class="xfer"><div class="composer"><div class="cbody" style="padding-top:22px">
      <div class="row" style="margin-bottom:6px"><div class="qi b" style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center">${icon("inbox")}</div><div><b style="font-size:17px;letter-spacing:-.02em">Demander des fichiers</b><div class="faint small">Un lien où n'importe qui peut déposer des fichiers</div></div></div>
      <input class="input" id="rt" placeholder="Titre — ex. « Photos du mariage »" maxlength="120"><textarea class="input" id="rm" placeholder="Message pour la personne (facultatif)"></textarea>
      <label class="field" style="margin-top:18px"><span>Les fichiers arriveront dans</span><select class="input" id="rs">${shares.map((s) => `<option value="${s.id}">${esc(shareLabel(s))}</option>`).join("")}</select><small>Un sous-dossier « Reçu de … » est créé pour chaque envoi.</small></label>
      <label class="field"><span>Le lien expire</span><select class="input" id="re"><option value="7">dans 7 jours</option><option value="30" selected>dans 30 jours</option><option value="0">jamais</option></select></label>
      <button class="btn primary lg block" id="rgo">Créer le lien de dépôt</button></div></div>
    <div><div class="section-title" style="margin-top:4px"><span class="grow">Mes demandes</span></div>
    ${list.length ? `<div class="card pad0">${list.map((r) => `<div class="xitem" data-url="${esc(publicLink("/s/" + r.token))}" data-s="${r.share_id}" data-p="${esc(r.relpath)}"><div class="xi qi ${r.expired ? "" : "b"}">${icon("inbox")}</div>
      <div class="grow"><b class="ellipsis" style="display:block;font-weight:600">${esc(r.title)}</b><span class="faint small">${r.uploads} fichier${r.uploads > 1 ? "s" : ""} reçu${r.uploads > 1 ? "s" : ""} · ${esc(r.share_name.startsWith("perso-") ? "Mes fichiers" : r.share_name)}${r.relpath ? "/" + esc(r.relpath) : ""} · ${r.expired ? "expiré" : r.expires_at ? "expire " + rel(r.expires_at) : "sans expiration"}</span></div>
      <button class="btn sm" data-copy>${icon("copy")}<span class="hide-m">Copier</span></button><button class="icon-btn" data-open title="Ouvrir le dossier">${icon("folder-open")}</button></div>`).join("")}</div>`
      : `<div class="card center" style="padding:40px 20px"><div class="qi b" style="width:56px;height:56px;border-radius:18px;display:grid;place-items:center;margin:0 auto 12px">${icon("inbox")}</div><b>Aucune demande</b><p class="muted small" style="margin:6px auto 0;max-width:340px">Idéal pour récupérer les photos d'un événement ou les fichiers d'un ami qui n'a pas de compte.</p></div>`}</div></div>`;
  paintIcons(box);
  $("#rgo", box).onclick = async () => {
    try { const r = await post("/api/requests", { share: +$("#rs", box).value, path: "", title: $("#rt", box).value || "Dépôt de fichiers", message: $("#rm", box).value, expires_days: +$("#re", box).value }); shareResult(publicLink(r.url), "Lien de dépôt prêt"); requests(box); }
    catch (e) { fail(e); }
  };
  box.querySelector(".card.pad0")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-url]"); if (!row) return;
    if (e.target.closest("[data-copy]")) copy(row.dataset.url);
    if (e.target.closest("[data-open]")) window.NAS.navigate(`/fichiers?${qs({ s: row.dataset.s, p: row.dataset.p || undefined })}`);
  });
}

// ------------------------------------------------------------------ liens de partage
async function links(box) {
  const list = await get("/api/links");
  box.innerHTML = list.length ? `<div class="card pad0">${list.map((l) => `<div class="xitem" data-id="${l.id}" data-url="${esc(publicLink("/s/" + l.token))}">
      <div class="xi qi ${l.expired ? "" : "o"}">${icon("link")}</div><div class="grow"><b class="ellipsis" style="display:block;font-weight:600">${esc(l.relpath.split("/").pop() || l.share_name)} ${l.has_password ? icon("lock", "star-mini") : ""}</b>
      <span class="faint small">${esc(l.share_name.startsWith("perso-") ? "Mes fichiers" : l.share_name)} · ${l.downloads} téléchargement${l.downloads > 1 ? "s" : ""} · ${l.expired ? "expiré" : l.expires_at ? "expire " + rel(l.expires_at) : "sans expiration"}${window.NAS.me.role === "admin" && l.author ? " · par " + esc(l.author) : ""}</span></div>
      <button class="btn sm" data-copy>${icon("copy")}<span class="hide-m">Copier</span></button><button class="icon-btn" data-del title="Supprimer">${icon("trash-2")}</button></div>`).join("")}</div>`
    : `<div class="empty"><div class="ico">${icon("link")}</div><h3>Aucun lien de partage</h3><p>Dans tes fichiers, fais un clic droit (ou ⋮) sur un fichier ou un dossier → « Partager un lien ».</p></div>`;
  paintIcons(box);
  box.onclick = async (e) => {
    const row = e.target.closest("[data-id]"); if (!row) return;
    if (e.target.closest("[data-copy]")) copy(row.dataset.url);
    if (e.target.closest("[data-del]") && await confirmBox("Supprimer ce lien ?", "Il ne fonctionnera plus. Les fichiers ne sont pas touchés.", { danger: true, ok: "Supprimer" })) { await del(`/api/links/${row.dataset.id}`); links(box); }
  };
  void date; void ago; void toast;
}

// « Partagés » : les dossiers communs, en cartes, avec qui y a accès. Création et gestion des accès simplifiées.
import { get, post, put, del, esc, icon, paintIcons, $, $$, toast, fail, confirmBox, drawer, switchEl, avatar, menu, initials } from "../ui.js";

const COLORS = ["o", "b", "g", "p", "pk", "t", "y"];
const ICONS = ["folder", "house", "images", "film", "music", "code", "castle", "gamepad-2", "book", "briefcase", "graduation-cap", "heart", "plane", "archive", "laptop", "star"];
const colorOf = (s) => COLORS[[...s.name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

export default async function (el, { query }) {
  const me = window.NAS.me;
  const [mine, manage, people, groups] = await Promise.all([get("/api/shares"), get("/api/manage/shares"), get("/api/people"), get("/api/groups")]);
  const ctx = { people, groups };
  const shares = mine.filter((s) => s.kind === "standard");
  const info = Object.fromEntries(manage.map((s) => [s.id, s]));
  const who = (s) => {
    const p = info[s.id]?.perms || [];
    const ids = new Set();
    p.forEach((x) => x.subject_type === "user" ? ids.add(x.subject_id) : (groups.find((g) => g.id === x.subject_id)?.members || []).forEach((m) => ids.add(m)));
    return [...ids].map((i) => people.find((u) => u.id === i)).filter(Boolean);
  };
  el.innerHTML = `<div class="page-header"><div class="titles"><h1>Partagés</h1><p>Les dossiers communs, accessibles aussi depuis les ordinateurs de la maison.</p></div>
    ${me.role !== "invite" ? `<div class="actions"><button class="btn primary" id="new">${icon("plus")}Nouveau dossier partagé</button></div>` : ""}</div>` +
    (shares.length ? `<div class="share-cards">${shares.map((s) => { const w = who(s); return `<a class="scard" href="/fichiers?s=${s.id}" data-link data-id="${s.id}">
      <div class="si qi ${colorOf(s)}">${icon(s.icon || "folder")}</div><b>${esc(s.name)}</b><div class="desc">${esc(s.description || "Dossier partagé")}</div>
      <div class="foot"><div class="avatars">${w.slice(0, 5).map((u) => avatar(u.display_name)).join("")}</div>${w.length > 5 ? `<span class="faint small">+${w.length - 5}</span>` : ""}
        <span class="grow"></span>${s.level === "read" ? `<span class="tag">${icon("eye")}Lecture</span>` : ""}</div>
      ${s.can_manage ? "" : `<span class="chev">${icon("chevron-right")}</span>`}
      ${s.can_manage ? `<button class="icon-btn more" data-more title="Options">${icon("ellipsis-vertical")}</button>` : ""}</a>`; }).join("")}</div>`
      : `<div class="empty"><div class="ico">${icon("users")}</div><h3>Aucun dossier partagé</h3><p>Crée un dossier commun et choisis qui peut y accéder.</p></div>`);
  paintIcons(el);
  $("#new", el) && ($("#new", el).onclick = () => editShare(null, ctx));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-more]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const s = info[+b.closest("[data-id]").dataset.id];
    menu(b, [
      { icon: "folder-open", label: "Ouvrir", onClick: () => window.NAS.navigate(`/fichiers?s=${s.id}`) },
      { icon: "user-plus", label: "Gérer l'accès", onClick: () => editShare(s, ctx) },
      "-",
      { icon: "folder-minus", label: "Arrêter le partage", danger: true, onClick: () => unshare(s) },
    ]);
  });
  if (query.get("new")) editShare(null, ctx);
}

async function unshare(s) {
  if (!(await confirmBox("Arrêter le partage ?", `« ${esc(s.name)} » ne sera plus partagé, mais <b>les fichiers sont conservés</b> sur le NAS.`, { danger: true, ok: "Arrêter le partage" }))) return;
  try { await del(`/api/manage/shares/${s.id}`); toast("Partage arrêté", "success"); window.NAS.render(); } catch (e) { fail(e); }
}

/** Éditeur d'un dossier partagé (création ou modification). */
export async function editShare(s, ctx) {
  const me = window.NAS.me;
  const { people, groups } = ctx || { people: await get("/api/people"), groups: await get("/api/groups") };
  const isNew = !s;
  s = s || { name: "", description: "", icon: "folder", smb: 1, photos: 0, perms: [], kind: "standard", tm_size_gb: 1000 };
  let perms = s.perms.map((p) => ({ ...p }));
  let ic = s.icon || "folder";
  const power = me.perms.manageShares;
  const subjects = [...groups.map((g) => ({ t: "group", id: g.id, name: g.name, sub: `Groupe · ${g.members.length} personne${g.members.length > 1 ? "s" : ""}` })),
    ...people.filter((p) => p.role !== "admin" && p.id !== me.id).map((p) => ({ t: "user", id: p.id, name: p.display_name, sub: p.role === "invite" ? "Invité" : "Famille" }))];
  const level = (x) => perms.find((p) => p.subject_type === x.t && p.subject_id === x.id)?.level || "none";
  const d = drawer({
    title: isNew ? "Nouveau dossier partagé" : s.name,
    body: `<form id="sf" onsubmit="return false">
      ${s.kind !== "personal" ? `<label class="field"><span>Nom</span><input class="input" name="name" value="${esc(s.name)}" maxlength="41" placeholder="Vacances 2026" required></label>` : ""}
      <label class="field"><span>Description</span><input class="input" name="description" value="${esc(s.description)}" maxlength="200" placeholder="Facultatif"></label>
      <div class="field"><span style="display:block;font-weight:550;margin-bottom:8px;font-size:13px">Icône</span><div class="row" style="flex-wrap:wrap;gap:6px" id="icons">${ICONS.map((i) => `<button type="button" class="btn icon sm ${ic === i ? "primary" : ""}" data-icon="${i}">${icon(i)}</button>`).join("")}</div></div>
      ${s.kind !== "personal" ? `<h3 style="margin:22px 0 4px;font-size:15px">Qui a accès ?</h3><p class="faint small" style="margin:0 0 8px">Les administrateurs ont toujours accès.</p>
      <div id="perms">${subjects.map((x) => `<div class="perm-row">${x.t === "group" ? `<div class="avatar neutral">${icon("users")}</div>` : avatar(x.name)}<div class="grow"><b>${esc(x.name)}</b><span>${esc(x.sub)}</span></div>
        <select class="input" style="width:auto;height:36px;border-radius:999px;font-size:13px" data-t="${x.t}" data-id="${x.id}"><option value="none" ${level(x) === "none" ? "selected" : ""}>Pas d'accès</option><option value="read" ${level(x) === "read" ? "selected" : ""}>Lecture</option><option value="write" ${level(x) === "write" ? "selected" : ""}>Modification</option></select></div>`).join("")}</div>` : ""}
      <h3 style="margin:22px 0 4px;font-size:15px">Options</h3>
      <div class="perm-row"><div class="grow"><b>Visible sur les ordinateurs</b><span>Comme un lecteur réseau (Windows, Mac)</span></div>${switchEl("smb", s.smb)}</div>
      <div class="perm-row"><div class="grow"><b>Afficher dans Photos</b><span>Les images de ce dossier apparaissent dans la chronologie</span></div>${switchEl("photos", s.photos)}</div>
      ${isNew && power ? `<details style="margin-top:12px"><summary class="faint small" style="cursor:pointer">Options avancées</summary><div style="margin-top:12px">
        <label class="field"><span>Emplacement sur le NAS</span><input class="input mono" name="path" placeholder="partages/mon-dossier"><small>Laisse vide pour « partages/ ». Un dossier existant peut être indiqué.</small></label>
        <label class="field"><span>Type</span><select class="input" name="kind"><option value="standard">Dossier partagé</option><option value="timemachine">Sauvegarde Time Machine (Mac)</option></select></label>
        <label class="field"><span>Taille max Time Machine (Go)</span><input class="input" type="number" name="tm_size_gb" value="1000" min="50"></label></div></details>` : ""}
      ${s.kind === "timemachine" ? `<label class="field" style="margin-top:12px"><span>Taille max Time Machine (Go)</span><input class="input" type="number" name="tm_size_gb" value="${s.tm_size_gb}" min="50"></label>` : ""}
      ${!isNew ? `<p class="faint small" style="margin-top:16px">Emplacement : <span class="mono">${esc(s.path)}</span>${s.owner_name ? ` · créé par ${esc(s.owner_name)}` : ""}</p>` : ""}
    </form>`,
    footer: `<button class="btn ghost" data-cancel>Annuler</button><button class="btn primary" id="save">${isNew ? "Créer" : "Enregistrer"}</button>`,
  });
  $("#icons", d).onclick = (e) => { const b = e.target.closest("[data-icon]"); if (!b) return; ic = b.dataset.icon; $$("[data-icon]", d).forEach((x) => x.classList.toggle("primary", x === b)); };
  d.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-t]"); if (!sel) return;
    perms = perms.filter((p) => !(p.subject_type === sel.dataset.t && p.subject_id === +sel.dataset.id));
    if (sel.value !== "none") perms.push({ subject_type: sel.dataset.t, subject_id: +sel.dataset.id, level: sel.value });
  });
  $("[data-cancel]", d).onclick = () => d.close();
  $("#save", d).onclick = async () => {
    const f = $("#sf", d);
    const body = { description: f.description.value, icon: ic, smb: f.smb.checked, photos: f.photos.checked, perms };
    if (f.name) body.name = f.name.value.trim();
    if (f.path?.value) body.path = f.path.value.trim();
    if (f.kind) body.kind = f.kind.value;
    if (f.tm_size_gb) body.tm_size_gb = +f.tm_size_gb.value;
    try {
      if (isNew) await post("/api/manage/shares", body); else await put(`/api/manage/shares/${s.id}`, body);
      toast(isNew ? "Dossier partagé créé" : "Modifications enregistrées", "success"); d.close();
      if (location.search.includes("new=1")) history.replaceState({}, "", location.pathname);
      window.NAS.render();
    } catch (e) { fail(e); }
  };
  void initials;
}

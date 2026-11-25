import { editShare } from "./shared.js";
import { get, post, put, del, esc, icon, paintIcons, $, $$, pageHeader, helpBanner, emptyState, chips, toast, fail, modal, confirmBox, drawer, switchEl } from "../ui.js";

const ICONS = ["folder", "house", "image", "film", "music", "code", "castle", "gamepad-2", "book", "briefcase", "graduation-cap", "heart", "share-2", "archive", "laptop", "star"];

export default async function (el, { tool }) {
  const adminView = tool?.id === "allshares";
  const me = window.NAS.me;
  const [shares, people, groups] = await Promise.all([get("/api/manage/shares"), get("/api/people"), get("/api/groups")]);
  let filter = "all";
  const kindLabel = { standard: "Partagé", personal: "Espace perso", timemachine: "Time Machine" };
  const subj = (p) => p.subject_type === "group" ? `${groups.find((g) => g.id === p.subject_id)?.name || "?"}` : (people.find((u) => u.id === p.subject_id)?.display_name || "?");

  const draw = () => {
    const list = shares.filter((s) => adminView ? true : s.kind !== "timemachine" && !(s.kind === "personal" && s.owner_id !== me.id))
      .filter((s) => filter === "all" || (filter === "mine" ? s.owner_id === me.id : s.kind === filter));
    el.innerHTML = pageHeader({
      title: adminView ? "Tous les partages" : "Dossiers partagés",
      desc: adminView ? "Tous les dossiers du NAS et qui peut y accéder." : "Crée des dossiers communs et choisis qui peut les lire ou les modifier.",
      actions: me.role !== "invite" ? `<button class="btn primary" id="new">${icon("folder-plus")}Nouveau dossier partagé</button>` : "",
    }) + helpBanner(adminView ? "allshares" : "shares", adminView ? "Tous les partages" : "Dossiers partagés", `
      <p>Un <b>dossier partagé</b> apparaît dans <a href="/fichiers" data-link>Fichiers</a> pour les personnes autorisées, et comme <b>lecteur réseau</b> sur les PC/Mac de la maison.</p>
      <p>Pour chaque personne ou groupe, choisis <b>Lecture</b> (voir et télécharger) ou <b>Écriture</b> (ajouter, modifier, supprimer). Les administrateurs ont toujours accès à tout.</p>
      <p>Tu peux modifier les permissions des dossiers que <b>tu as créés</b>.</p>`) +
      chips([{ value: "all", label: "Tous", count: null }, { value: "mine", label: "Créés par moi" }, ...(adminView ? [{ value: "standard", label: "Partagés" }, { value: "personal", label: "Espaces perso" }, { value: "timemachine", label: "Time Machine" }] : [])], filter) +
      (list.length ? `<div class="card pad0 table-wrap"><table class="table"><thead><tr><th>Dossier</th><th class="hide-m">Accès</th><th class="hide-m">Options</th><th></th></tr></thead><tbody>
        ${list.map((s) => `<tr data-id="${s.id}"><td><div class="row"><div class="ficon folder">${icon(s.kind === "personal" ? "user-round" : s.kind === "timemachine" ? "laptop" : s.icon)}</div>
          <div class="grow"><b>${esc(s.name)}</b><div class="faint small ellipsis">${esc(s.description || s.path)}</div></div></div></td>
          <td class="hide-m">${s.kind === "personal" ? `<span class="tag">${icon("lock")}${esc(s.owner_name || "—")}</span>` :
            s.perms.length ? s.perms.slice(0, 4).map((p) => `<span class="tag ${p.level === "write" ? "orange" : ""}" style="margin:2px">${icon(p.subject_type === "group" ? "users" : "user")}${esc(subj(p))}</span>`).join("") + (s.perms.length > 4 ? ` <span class="faint small">+${s.perms.length - 4}</span>` : "") : `<span class="faint small">Admins uniquement</span>`}</td>
          <td class="hide-m">${s.smb ? `<span class="tag" title="Visible comme lecteur réseau">${icon("monitor")}PC/Mac</span> ` : ""}${s.photos ? `<span class="tag">${icon("image")}Photos</span> ` : ""}${s.kind !== "standard" ? `<span class="tag">${kindLabel[s.kind]}</span>` : ""}</td>
          <td class="num">${s.can_manage ? `<button class="btn sm" data-edit>${icon("settings-2")}<span class="hide-m">Gérer</span></button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState("folders", "Aucun dossier", filter === "mine" ? "Tu n'as pas encore créé de dossier partagé." : ""));
    paintIcons(el);
    $(".chips", el).onclick = (e) => { const c = e.target.closest("[data-chip]"); if (c) { filter = c.dataset.chip; draw(); } };
    $("#new", el) && ($("#new", el).onclick = () => editor(null));
    $("tbody", el)?.addEventListener("click", (e) => { if (e.target.closest("[data-edit]")) editor(shares.find((s) => s.id === +e.target.closest("tr").dataset.id)); });
  };

  const editor = (s) => editShare(s, { people, groups });
  draw();
}

import { get, post, put, del, esc, icon, paintIcons, $, pageHeader, helpBanner, emptyState, toast, fail, modal, confirmBox, promptBox, date } from "../ui.js";
import { tile, openViewer } from "./photos.js";

export default async function (el, { params }) {
  return params[0] ? album(el, +params[0]) : list(el);
}

async function list(el) {
  const albums = await get("/api/albums");
  el.innerHTML = pageHeader({ title: "Albums", desc: "Des sélections de photos à partager avec la famille.",
    actions: `<button class="btn primary" id="new">${icon("plus")}Nouvel album</button>` }) +
    helpBanner("albums", "Albums", `<p>Un album regroupe des photos venant de n'importe quel dossier. Les personnes avec qui tu le partages voient <b>uniquement les photos de l'album</b>, même si elles n'ont pas accès au dossier d'origine.</p>
      <p>Pour remplir un album : va dans <a href="/photos" data-link>Photos</a>, sélectionne des photos puis « Ajouter à un album ».</p>`) +
    (albums.length ? `<div class="grid c4">${albums.map((a) => `<a class="card album-card" href="/albums/${a.id}" data-link>
      <div class="cover">${a.last_photo ? `<img loading="lazy" src="/api/photos/${a.last_photo}/thumb?size=640" alt="">` : icon("book-image")}</div>
      <div class="info"><b class="ellipsis" style="display:block">${esc(a.name)}</b><span class="faint small">${a.n} élément${a.n > 1 ? "s" : ""}${a.mine ? (a.members.length ? ` · partagé avec ${a.members.length}` : " · privé") : ` · par ${esc(a.owner_name)}`}</span></div></a>`).join("")}</div>`
      : emptyState("book-image", "Aucun album", "Crée un album puis ajoute-y des photos depuis la chronologie."));
  paintIcons(el);
  $("#new", el).onclick = async () => {
    const n = await promptBox("Nouvel album", "Nom de l'album", "", { ok: "Créer", placeholder: "Noël 2026" });
    if (!n) return;
    try { const r = await post("/api/albums", { name: n }); window.NAS.navigate(`/albums/${r.id}`); } catch (e) { fail(e); }
  };
}

async function album(el, id) {
  const a = await get(`/api/albums/${id}`);
  const people = await get("/api/people");
  const sel = new Set();
  const names = a.members.map((m) => people.find((p) => p.id === m)?.display_name).filter(Boolean);
  el.innerHTML = pageHeader({
    title: a.name, back: { href: "/albums", label: "Albums" },
    desc: `${a.items.length} élément(s) · ${names.length ? "partagé avec " + names.join(", ") : "visible seulement par toi"}`,
    actions: a.mine ? `<button class="btn" id="share">${icon("users")}Partager</button><button class="btn icon" id="ren" title="Renommer">${icon("pencil")}</button><button class="btn icon danger" id="del" title="Supprimer l'album">${icon("trash-2")}</button>` : "",
  }) + `<div id="selbar"></div>` + (a.items.length ? `<div class="pgrid" id="g">${a.items.map(tile).join("")}</div>` :
    emptyState("image-plus", "Album vide", "Ajoute des photos depuis la chronologie (sélectionne-les puis « Ajouter à un album »).", `<a class="btn primary" href="/photos" data-link>Aller aux photos</a>`));
  paintIcons(el);
  $("#g", el)?.addEventListener("click", (e) => {
    const t = e.target.closest("[data-id]"); if (!t) return;
    const pid = +t.dataset.id;
    if (a.mine && (e.target.closest(".sel") || sel.size)) {
      sel.has(pid) ? sel.delete(pid) : sel.add(pid); t.classList.toggle("selected");
      $("#selbar", el).innerHTML = sel.size ? `<div class="selbar"><b>${sel.size} sélectionnée(s)</b><span class="grow"></span><button class="btn sm danger" id="rm">${icon("x")}Retirer de l'album</button></div>` : "";
      paintIcons($("#selbar", el));
      $("#rm", el) && ($("#rm", el).onclick = async () => { await post(`/api/albums/${id}/remove`, { photos: [...sel] }); toast("Retiré de l'album", "success"); album(el, id); });
      return;
    }
    openViewer(a.items, a.items.findIndex((p) => p.id === pid));
  });
  if (!a.mine) return;
  $("#ren", el).onclick = async () => { const n = await promptBox("Renommer l'album", "Nom", a.name); if (n) { await put(`/api/albums/${id}`, { name: n }); album(el, id); } };
  $("#del", el).onclick = async () => { if (await confirmBox("Supprimer l'album ?", "Les photos ne sont pas supprimées, seulement l'album.", { danger: true, ok: "Supprimer" })) { await del(`/api/albums/${id}`); window.NAS.navigate("/albums"); } };
  $("#share", el).onclick = async () => {
    const r = await modal({
      title: "Partager l'album", body: `<p class="muted" style="margin-top:0">Ces personnes pourront voir et télécharger les photos de l'album.</p>` +
        people.filter((p) => p.id !== window.NAS.me.id).map((p) => `<div class="perm-row"><div class="avatar">${esc(p.display_name[0])}</div><div class="grow"><b>${esc(p.display_name)}</b><span>${p.role === "invite" ? "Invité" : "Famille"}</span></div>
        <label class="switch"><input type="checkbox" value="${p.id}" ${a.members.includes(p.id) ? "checked" : ""}><span class="track"></span></label></div>`).join(""),
      actions: [{ label: "Annuler", cls: "ghost" }, { label: "Enregistrer", cls: "primary", onClick: async (m) => { await put(`/api/albums/${id}`, { members: [...m.querySelectorAll("input:checked")].map((i) => +i.value) }); return true; } }],
    });
    if (r) { toast("Partage mis à jour", "success"); album(el, id); }
  };
}

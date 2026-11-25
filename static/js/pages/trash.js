import { get, post, esc, icon, paintIcons, $, $$, pageHeader, helpBanner, emptyState, chips, toast, fail, confirmBox, size, date } from "../ui.js";

export default async function (el) {
  let items = await get("/api/trash");
  let filter = 0;
  const sel = new Set();
  const key = (i) => i.share + ":" + i.item;
  const draw = () => {
    const shares = [...new Map(items.map((i) => [i.share, i.share_name]))];
    const list = items.filter((i) => !filter || i.share === filter);
    const total = list.reduce((a, i) => a + i.size, 0);
    el.innerHTML = pageHeader({ title: "Corbeille", desc: `Les fichiers supprimés depuis l'app ou depuis un PC/Mac. ${items.length ? `${items.length} élément(s), ${size(total)}.` : ""}`,
      actions: items.length ? `<button class="btn danger" id="empty">${icon("trash-2")}Vider${filter ? " ce dossier" : " la corbeille"}</button>` : "" }) +
      helpBanner("trash", "Corbeille", `<p>Rien n'est effacé automatiquement : les fichiers restent ici <b>jusqu'à ce que quelqu'un vide la corbeille</b>. Pense à la vider de temps en temps pour libérer de la place.</p>
        <p><b>Restaurer</b> remet le fichier à son emplacement d'origine. Tu vois la corbeille de tous les dossiers où tu as le droit d'écriture.</p>`) +
      (items.length ? (shares.length > 1 ? chips([{ value: 0, label: "Tout", count: items.length }, ...shares.map(([id, n]) => ({ value: id, label: n.startsWith("perso-") ? "Mon espace" : n, count: items.filter((i) => i.share === id).length }))], filter) : "") +
        `<div id="sb"></div><div class="card pad0 table-wrap"><table class="table"><thead><tr><th style="width:30px"><input type="checkbox" class="check" id="all"></th><th>Fichier</th><th class="hide-m">Supprimé</th><th class="hide-m num">Taille</th><th></th></tr></thead><tbody>
        ${list.slice(0, 1000).map((i, n) => `<tr data-n="${n}"><td><input type="checkbox" class="check" ${sel.has(key(i)) ? "checked" : ""}></td><td><b>${esc(i.orig.split("/").pop())}</b><div class="faint small ellipsis">${esc(i.share_name)}/${esc(i.orig)} · par ${esc(i.by)}</div></td>
          <td class="hide-m">${date(i.deleted_at)}</td><td class="hide-m num">${size(i.size)}</td><td class="num"><button class="btn sm" data-r>${icon("undo-2")}<span class="hide-m">Restaurer</span></button></td></tr>`).join("")}</tbody></table></div>`
        : emptyState("trash-2", "La corbeille est vide", "Tout ce que tu supprimes arrive ici et peut être restauré."));
    paintIcons(el);
    $(".chips", el) && ($(".chips", el).onclick = (e) => { const c = e.target.closest("[data-chip]"); if (c) { filter = +c.dataset.chip; sel.clear(); draw(); } });
    const sb = () => { if (!$("#sb", el)) return; $("#sb", el).innerHTML = sel.size ? `<div class="selbar"><b>${sel.size} sélectionné(s)</b><span class="grow"></span><button class="btn sm" id="rs">${icon("undo-2")}Restaurer</button><button class="btn sm danger" id="dl">${icon("x")}Supprimer définitivement</button></div>` : ""; paintIcons($("#sb", el)); bindSel(); };
    const pick = () => items.filter((i) => sel.has(key(i))).map((i) => ({ share: i.share, item: i.item }));
    const bindSel = () => {
      $("#rs", el) && ($("#rs", el).onclick = () => act("/api/trash/restore", pick(), "Restauré"));
      $("#dl", el) && ($("#dl", el).onclick = async () => { if (await confirmBox("Supprimer définitivement ?", `${sel.size} élément(s) seront effacés <b>pour toujours</b>.`, { danger: true, ok: "Supprimer" })) act("/api/trash/delete", pick(), "Supprimé définitivement"); });
    };
    $("tbody", el)?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr"); if (!tr) return; const it = list[+tr.dataset.n];
      if (e.target.closest("[data-r]")) return act("/api/trash/restore", [{ share: it.share, item: it.item }], "Restauré");
      if (e.target.classList.contains("check")) { sel.has(key(it)) ? sel.delete(key(it)) : sel.add(key(it)); sb(); }
    });
    $("#all", el) && ($("#all", el).onchange = (e) => { list.forEach((i) => (e.target.checked ? sel.add(key(i)) : sel.delete(key(i)))); draw(); });
    $("#empty", el) && ($("#empty", el).onclick = async () => {
      if (!(await confirmBox("Vider la corbeille ?", `Tous les fichiers ${filter ? "de ce dossier " : ""}seront effacés <b>définitivement</b> (${size(total)}). Cette action est irréversible.`, { danger: true, ok: "Vider" }))) return;
      try { await post("/api/trash/empty", { share: filter || undefined }); toast("Corbeille vidée", "success"); items = await get("/api/trash"); filter = 0; draw(); } catch (e) { fail(e); }
    });
    sb();
  };
  const act = async (url, its, msg) => { try { await post(url, { items: its }); toast(msg, "success"); sel.clear(); items = await get("/api/trash"); draw(); } catch (e) { fail(e); } };
  draw();
}

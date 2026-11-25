import { get, esc, icon, paintIcons, $, pageHeader, helpBanner, emptyState, date } from "../ui.js";

export default async function (el) {
  let q = "", rows = await get("/api/admin/audit");
  const draw = () => {
    $("#rows", el).innerHTML = rows.length ? `<div class="card pad0 table-wrap"><table class="table"><thead><tr><th>Date</th><th>Qui</th><th>Action</th><th class="hide-m">Cible</th><th class="hide-m">Détail</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="small" style="white-space:nowrap">${date(r.ts)}</td><td><b>${esc(r.username || "—")}</b><div class="faint small mono">${esc(r.ip || "")}</div></td>
        <td><span class="tag ${r.action.includes("echec") || r.action.includes("supprim") || r.action.includes("definitive") ? "red" : r.action.startsWith("login") ? "" : "orange"}">${esc(r.action)}</span></td>
        <td class="hide-m small">${esc(r.target)}</td><td class="hide-m small faint ellipsis" style="max-width:340px" title="${esc(r.detail)}">${esc(r.detail)}</td></tr>`).join("")}</tbody></table></div>
      ${rows.length >= 200 ? `<p style="text-align:center"><button class="btn" id="more">Voir plus ancien</button></p>` : ""}` : emptyState("scroll-text", "Rien trouvé");
    paintIcons(el);
    $("#more", el) && ($("#more", el).onclick = async () => { rows.push(...(await get(`/api/admin/audit?q=${encodeURIComponent(q)}&before=${rows[rows.length - 1].id}`))); draw(); });
  };
  el.innerHTML = pageHeader({ title: "Journal d'audit", desc: "Qui a fait quoi et quand : connexions, comptes, partages, suppressions…" }) +
    helpBanner("audit", "Journal d'audit", `<p>Chaque action sensible est enregistrée ici. Les <b>connexions échouées</b> apparaissent en rouge : beaucoup d'échecs pour un même compte peuvent indiquer qu'on essaie de deviner un mot de passe (le NAS bloque après 5 essais).</p>`) +
    `<div class="search" style="max-width:420px;margin-bottom:16px">${icon("search")}<input class="input" id="q" placeholder="Filtrer (nom, action, dossier…)"></div><div id="rows"></div>`;
  draw();
  let t; $("#q", el).oninput = (e) => { clearTimeout(t); t = setTimeout(async () => { q = e.target.value; rows = await get(`/api/admin/audit?q=${encodeURIComponent(q)}`); draw(); }, 300); };
}

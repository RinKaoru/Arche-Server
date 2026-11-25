import { get, put, post, esc, icon, paintIcons, $, pageHeader, helpBanner, emptyState, toast, fail, switchEl, size, ago } from "../ui.js";

export default async function (el) {
  const g = await get("/api/admin/github");
  el.innerHTML = pageHeader({ title: "Sauvegarde GitHub", desc: "Une copie complète de vos dépôts GitHub, mise à jour chaque nuit.",
    actions: `<button class="btn" id="sync" ${g.owners.length ? "" : "disabled"}>${icon(g.running ? "loader" : "refresh-cw")}${g.running ? "En cours…" : "Synchroniser maintenant"}</button>` }) +
    helpBanner("github", "Sauvegarde GitHub", `<p>Le NAS clone chaque dépôt en <b>miroir</b> (toutes les branches, tous les tags) dans <span class="mono">Sauvegardes/github</span>, chaque nuit à 4h. Si un dépôt est supprimé ou un historique écrasé sur GitHub, vous avez une copie.</p>
      <p>Pour les <b>dépôts privés</b>, crée un token sur github.com → Settings → Developer settings → <b>Fine-grained tokens</b>, avec accès en <b>lecture seule</b> à « Contents » et « Metadata » sur les dépôts voulus.</p>`) +
    `<div class="card" style="margin-bottom:16px"><form id="gf">
      <label class="field"><span>Comptes ou organisations GitHub</span><input class="input" name="owners" value="${esc(g.owners.join(", "))}" placeholder="ton-pseudo, mon-organisation"><small>Séparés par des virgules. Tous leurs dépôts seront sauvegardés.</small></label>
      <label class="field"><span>Token d'accès (facultatif, pour les dépôts privés)</span><input class="input mono" name="token" type="password" autocomplete="off" placeholder="${g.has_token ? "•••••••• (enregistré — laisser vide pour le garder)" : "github_pat_…"}"></label>
      <div class="perm-row"><div class="grow"><b>Sauvegarde automatique chaque nuit</b><span>À 4h du matin</span></div>${switchEl("enabled", g.enabled)}</div>
      <div class="actions" style="margin-top:12px"><button class="btn primary">Enregistrer</button>${g.has_token ? `<button type="button" class="btn ghost danger" id="ct">Oublier le token</button>` : ""}</div></form></div>` +
    (g.repos.length ? `<div class="card pad0 table-wrap"><table class="table"><thead><tr><th>Dépôt</th><th>État</th><th class="hide-m">Taille</th><th class="hide-m">Dernière copie</th></tr></thead><tbody>
      ${g.repos.map((r) => `<tr><td><b>${esc(r.full_name)}</b> ${r.private ? `<span class="tag">${icon("lock")}privé</span>` : ""}${r.detail ? `<div class="small" style="color:var(--error)">${esc(r.detail.slice(-160))}</div>` : ""}</td>
        <td>${r.status === "ok" ? `<span class="tag green">OK</span>` : `<span class="tag red">Erreur</span>`}</td><td class="hide-m">${size(r.size)}</td><td class="hide-m small">${ago(r.last_sync)}</td></tr>`).join("")}</tbody></table></div>`
      : emptyState("github", "Aucun dépôt sauvegardé", "Indique vos comptes GitHub ci-dessus puis lance une synchronisation."));
  paintIcons(el);
  $("#gf", el).onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await put("/api/admin/github", { owners: f.owners.value.split(/[,\s]+/).filter(Boolean), token: f.token.value, enabled: f.enabled.checked }); toast("Enregistré", "success"); window.NAS.render(); } catch (er) { fail(er); }
  };
  $("#ct", el) && ($("#ct", el).onclick = async () => { await put("/api/admin/github", { clear_token: true }); window.NAS.render(); });
  $("#sync", el).onclick = async () => { await post("/api/admin/github/sync"); toast("Synchronisation lancée, ça peut prendre quelques minutes", "success"); setTimeout(() => location.pathname === "/admin/github" && window.NAS.render(), 15000); };
}

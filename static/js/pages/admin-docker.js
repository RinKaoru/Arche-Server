import { get, post, esc, icon, paintIcons, $, pageHeader, helpBanner, emptyState, toast, fail, drawer, spinner } from "../ui.js";

export default async function (el) {
  const cs = await get("/api/admin/docker");
  el.innerHTML = pageHeader({ title: "Docker", desc: "Les conteneurs de vos projets qui tournent sur le NAS.", actions: `<button class="btn" id="rf">${icon("refresh-cw")}Actualiser</button>` }) +
    helpBanner("docker", "Docker", `<p>Docker permet de faire tourner vos projets (bots, sites, API, serveurs de test…) sur le NAS de façon isolée. Les conteneurs se créent en SSH avec <span class="mono">docker compose</span> ; ici tu peux les <b>surveiller, démarrer, arrêter et lire leurs journaux</b>.</p>
      <p>Bonne pratique : un dossier par projet dans <span class="mono">/srv/storage/projets/&lt;projet&gt;</span> avec son <span class="mono">compose.yaml</span>. Les ports publiés ne sont accessibles que depuis la maison et le VPN.</p>`) +
    (cs.length ? `<div class="card pad0 table-wrap"><table class="table"><thead><tr><th>Conteneur</th><th>État</th><th class="hide-m">Ports</th><th></th></tr></thead><tbody>
      ${cs.map((c) => { const up = c.State === "running"; return `<tr data-id="${esc(c.ID)}" data-name="${esc(c.Names)}"><td><b>${esc(c.Names)}</b><div class="faint small mono ellipsis" style="max-width:340px">${esc(c.Image)}</div></td>
        <td><span class="tag ${up ? "green" : c.State === "exited" ? "" : "yellow"}">${esc(c.State)}</span><div class="faint small">${esc(c.Status)}</div></td><td class="hide-m small mono">${esc(c.Ports || "—")}</td>
        <td class="num" style="white-space:nowrap">${up ? `<button class="btn sm icon" data-a="restart" title="Redémarrer">${icon("rotate-cw")}</button> <button class="btn sm icon danger" data-a="stop" title="Arrêter">${icon("square")}</button>` : `<button class="btn sm icon" data-a="start" title="Démarrer">${icon("play")}</button>`}
        <button class="btn sm icon" data-logs title="Journaux">${icon("scroll-text")}</button></td></tr>`; }).join("")}</tbody></table></div>`
      : emptyState("container", "Aucun conteneur", "Docker est installé et prêt. Lance un projet en SSH avec « docker compose up -d » et il apparaîtra ici."));
  paintIcons(el);
  $("#rf", el).onclick = () => window.NAS.render();
  $("tbody", el)?.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a) { e.target.closest("button").disabled = true; try { await post(`/api/admin/docker/${encodeURIComponent(tr.dataset.id.slice(0, 12))}/${a}`); toast("C'est fait", "success"); window.NAS.render(); } catch (er) { fail(er); } }
    if (e.target.closest("[data-logs]")) {
      const d = drawer({ title: "Journaux · " + tr.dataset.name, body: spinner() });
      d.style.width = "min(900px,100vw)";
      const r = await get(`/api/admin/docker/${encodeURIComponent(tr.dataset.id.slice(0, 12))}/logs`);
      d.querySelector(".body").innerHTML = `<pre class="logs">${esc(r.logs || "(vide)")}</pre>`;
      const pre = d.querySelector("pre"); pre.scrollTop = pre.scrollHeight;
    }
  });
}

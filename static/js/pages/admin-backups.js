import { get, post, esc, icon, paintIcons, $, pageHeader, helpBanner, toast, fail, size } from "../ui.js";

export default async function (el) {
  const s = await get("/api/admin/snapshots");
  const st = s.state;
  el.innerHTML = pageHeader({ title: "Snapshots", desc: "Les copies quotidiennes du NAS pour revenir en arrière.", actions: `<button class="btn" id="run">${icon("play")}Lancer un snapshot maintenant</button>` }) +
    helpBanner("snapshots", "Snapshots", `<p>Chaque nuit à 2h30, le NAS prend une « photo » de tous les fichiers. Un fichier qui n'a pas changé n'occupe pas de place en plus. On garde <b>7 jours, 4 semaines et 6 mois</b>.</p>
      <p>Pour récupérer une ancienne version : dans <a href="/fichiers" data-link>Fichiers</a>, menu « … » d'un fichier → <b>Versions précédentes</b>.</p>
      <p>⚠️ Les snapshots sont sur les mêmes disques que les données : ils protègent contre les <b>erreurs</b> et les <b>suppressions</b>, pas contre la perte du RAID. Une copie externe (disque USB, cloud) reste recommandée pour les photos de famille.</p>`) +
    `<div class="grid c3"><div class="card stat"><div class="label">${icon("circle-check")}Dernier snapshot</div><div class="value" style="color:${st?.ok ? "var(--success)" : "var(--error)"}">${st ? (st.ok ? "Réussi" : "Échec") : "Aucun"}</div><div class="sub">${st ? esc(new Date(st.date).toLocaleString("fr-FR")) + ` · ${st.seconds} s` : ""}</div></div>
      <div class="card stat"><div class="label">${icon("history")}Conservés</div><div class="value">${s.dates.length}</div><div class="sub">du ${s.dates.length ? esc(s.dates[s.dates.length - 1]) : "—"} au ${s.dates.length ? esc(s.dates[0]) : "—"}</div></div>
      <div class="card stat"><div class="label">${icon("circle-slash")}Exclus</div><div class="value" style="font-size:16px">${s.excluded.map(esc).join(", ")}</div><div class="sub">Films/séries (réimportables), Time Machine (a ses propres versions), corbeilles</div></div></div>
    ${systemCard(s.system)}
    <h3 style="margin:24px 0 10px">${icon("camera")} Snapshots du NAS</h3>
    <div class="card pad0">${s.dates.map((d) => `<div class="list-item"><div class="ic info">${icon("camera")}</div><b class="grow">${esc(new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</b><span class="faint small mono">${esc(d)}</span></div>`).join("")}</div>`;
  paintIcons(el);
  $("#run", el).onclick = async () => { try { await post("/api/admin/snapshots/run"); toast("Snapshot lancé en arrière-plan", "success"); } catch (e) { fail(e); } };
}

function systemCard(sys) {
  const okc = (v) => `color:${v ? "var(--success)" : "var(--error)"}`;
  const when = (d) => (d ? esc(new Date(d).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })) : "—");
  return `<h3 style="margin:24px 0 10px">${icon("server")} Autres sauvegardes</h3>
  <div class="grid c2">
    <div class="card"><div class="label" style="display:flex;gap:8px;align-items:center">${icon("hard-drive")}<b>Disque système du NAS</b><span class="faint small">chaque nuit à 2h30</span></div>
      ${sys ? `<div class="value" style="${okc(sys.ok)};font-size:20px;margin:8px 0 2px">${sys.ok ? "Réussie" : "Échec"}</div><div class="faint small">${when(sys.date)} · ${esc(sys.size)}</div>
      <p class="small" style="margin:10px 0 0">Comptes, réglages, base de l'app et configuration (30 jours conservés).</p>` : `<p class="faint">Pas encore de sauvegarde.</p>`}
    </div>
  </div>
  <p class="faint small" style="margin-top:8px">Ces copies sont réservées à root (elles contiennent des secrets). Pour une restauration, demande à l'administrateur.</p>`;
}

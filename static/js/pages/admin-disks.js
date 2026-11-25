import { get, post, esc, icon, paintIcons, $, pageHeader, helpBanner, size, toast } from "../ui.js";

export default async function (el) {
  const o = await get("/api/admin/overview");
  const disk = (d) => {
    const bad = (d.reallocated || 0) + (d.pending || 0) + (d.uncorrectable || 0);
    const state = d.healthy === false ? ["ko", "Défaillant", "red"] : bad ? ["warn", "À surveiller", "yellow"] : d.healthy ? ["ok", "Sain", "green"] : ["", "Inconnu", ""];
    const years = d.hours ? (d.hours / 8766).toFixed(1) : null;
    const inRaid = o.raid.some((r) => r.devices.some(([n]) => n === d.name));
    return `<div class="card"><div class="row" style="margin-bottom:12px"><div class="ficon folder">${icon(d.hdd ? "hard-drive" : "memory-stick")}</div><div class="grow"><b>${esc(d.model || d.name)}</b><div class="faint small mono">/dev/${esc(d.name)} · ${esc(d.serial || "")}</div></div><span class="tag ${state[2]}">${state[1]}</span></div>
      <dl class="kv small"><dt>Capacité</dt><dd>${size(d.size)} ${d.hdd ? "(HDD)" : "(SSD)"}</dd><dt>Rôle</dt><dd>${inRaid ? "Membre du RAID" : "Système"}</dd>
      <dt>Température</dt><dd style="color:${(d.temp || 0) >= 50 ? "var(--error)" : (d.temp || 0) >= 45 ? "var(--warning)" : ""}">${d.temp ?? "?"} °C</dd>
      <dt>En service</dt><dd>${d.hours ? `${d.hours.toLocaleString("fr-FR")} h (${years} ans)` : "?"}</dd>
      <dt>Secteurs réalloués</dt><dd>${d.reallocated ?? "—"}</dd><dt>Secteurs en attente</dt><dd>${d.pending ?? "—"}</dd><dt>Erreurs non corrigibles</dt><dd>${d.uncorrectable ?? "—"}</dd></dl>
      ${d.tests.length ? `<hr><div class="faint small" style="margin-bottom:6px">Derniers auto-tests</div>${d.tests.slice(0, 3).map((t) => `<div class="row small"><span class="dot ${t.passed ? "ok" : "ko"}"></span><span class="grow">${esc(t.type)}</span><span class="faint">${esc(t.status)} · à ${t.hours} h</span></div>`).join("")}` : ""}</div>`;
  };
  el.innerHTML = pageHeader({ title: "Disques & RAID", desc: "La santé de chaque disque et du RAID.", actions: `<button class="btn" id="rf">${icon("refresh-cw")}Relire SMART</button>` }) +
    helpBanner("disks", "Disques & RAID", `<p><b>RAID 5</b> : les données sont réparties sur les 3 disques avec une parité. Si <b>un</b> disque tombe en panne, tout continue de fonctionner (mode « dégradé ») : il faut alors le remplacer vite, car une 2ᵉ panne ferait tout perdre.</p>
      <p>Signes d'usure à surveiller : <b>secteurs réalloués ou en attente</b> qui augmentent, température au-dessus de 45 °C. Un test court a lieu chaque nuit et un test long chaque samedi.</p>`) +
    o.raid.map((r) => `<div class="card" style="margin-bottom:16px"><h3>${icon("layers")}${esc(r.name)} — ${esc(r.level.toUpperCase())}</h3><div class="grid c4">
      <div class="stat"><div class="label">État</div><div class="value" style="color:${r.degraded ? "var(--error)" : "var(--success)"}">${r.degraded ? "Dégradé" : "Sain"}</div></div>
      <div class="stat"><div class="label">Capacité utile</div><div class="value">${size(r.size)}</div></div>
      <div class="stat"><div class="label">Disques</div><div class="value">${r.active}/${r.expected} <span class="mono small">[${r.bits}]</span></div><div class="sub">${r.devices.map(([n, f]) => n + (f ? " (EN PANNE)" : "")).join(", ")}</div></div>
      <div class="stat"><div class="label">Opération</div><div class="value" style="font-size:18px">${r.action ? `${r.action} ${r.progress}%` : "Aucune"}</div><div class="sub">${r.finish ? "fin dans " + r.finish : "Vérification complète chaque mois"}</div></div></div></div>`).join("") +
    `<div class="grid c2">${o.disks.map(disk).join("")}</div>`;
  paintIcons(el);
  $("#rf", el).onclick = async () => { $("#rf", el).disabled = true; await post("/api/admin/refresh"); toast("SMART relu", "success"); window.NAS.render(); };
}

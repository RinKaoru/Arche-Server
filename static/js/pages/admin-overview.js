import { get, post, esc, icon, paintIcons, $, pageHeader, helpBanner, size, duration, ago, bar, toast } from "../ui.js";

export const LV = { error: ["circle-alert", "red"], warning: ["triangle-alert", "yellow"], success: ["circle-check", "green"], info: ["info", ""] };

export default async function (el) {
  const draw = async () => {
    const o = await get("/api/admin/overview");
    const active = o.alerts.filter((a) => a.active);
    const st = o.storage, raid = o.raid[0];
    const badDisks = o.disks.filter((d) => d.healthy === false || (d.reallocated || 0) + (d.pending || 0) > 0).length;
    const svcDown = o.services.filter((s) => !s.active && !(s.unit === "tailscaled" && o.tailscale?.state === "NeedsLogin"));
    const net = Object.entries(o.net || {}).filter(([k]) => !k.startsWith("tailscale"))[0];
    el.innerHTML = pageHeader({ title: "Vue d'ensemble", desc: "L'état du NAS en un coup d'œil. Mise à jour toutes les 30 secondes.",
      actions: `<span class="faint small">Mis à jour ${ago(o.updated)}</span><button class="btn" id="rf">${icon("refresh-cw")}Actualiser</button>` }) +
      helpBanner("overview", "Vue d'ensemble", `<p>Si tout est vert, tout va bien. Les <b>alertes</b> apparaissent en haut et sont aussi envoyées en notification aux personnes ayant la permission « Supervision ».</p>
        <p>Une alerte disparaît d'elle-même quand le problème est résolu.</p>`) +
      (active.length ? `<div class="card pad0" style="border-color:rgba(231,76,60,.35);margin-bottom:16px">${active.map((a) => `<div class="list-item"><div class="ic ${a.level}">${icon(LV[a.level]?.[0] || "info")}</div><div class="grow"><b>${esc(a.title)}</b><div class="muted small">${esc(a.body)}</div></div><span class="faint small">depuis ${ago(a.since)}</span></div>`).join("")}</div>`
        : `<div class="card row" style="margin-bottom:16px;border-color:rgba(46,204,113,.3)"><span class="dot ok"></span><b class="grow">Tout fonctionne normalement</b><span class="faint small">Aucune alerte en cours</span></div>`) +
      `<div class="grid c4">
        <div class="card stat"><div class="label">${icon("database")}Stockage</div><div class="value">${st ? st.pct + " %" : "Non monté"}</div><div class="sub">${st ? `${size(st.used)} / ${size(st.total)} · ${size(st.free)} libres` : ""}</div>${st ? bar(st.pct) : ""}</div>
        <div class="card stat"><div class="label">${icon("layers")}RAID</div><div class="value" style="color:${raid?.degraded ? "var(--error)" : "var(--success)"}">${raid ? (raid.degraded ? "Dégradé" : raid.action ? "En cours" : "Sain") : "—"}</div><div class="sub">${raid ? `${raid.level.toUpperCase()} · ${raid.active}/${raid.expected} disques [${raid.bits}]${raid.action ? ` · ${raid.action} ${raid.progress}%` : ""}` : ""}</div></div>
        <div class="card stat"><div class="label">${icon("hard-drive")}Disques</div><div class="value" style="color:${badDisks ? "var(--warning)" : "var(--success)"}">${badDisks ? badDisks + " à surveiller" : "Tous sains"}</div><div class="sub">${o.disks.map((d) => `${d.name} ${d.temp ?? "?"}°C`).join(" · ")}</div></div>
        <div class="card stat"><div class="label">${icon("server-cog")}Services</div><div class="value" style="color:${svcDown.length ? "var(--error)" : "var(--success)"}">${svcDown.length ? svcDown.length + " arrêté(s)" : "Tous actifs"}</div><div class="sub">${o.services.length} services surveillés</div></div>
        <div class="card stat"><div class="label">${icon("cpu")}Processeur</div><div class="value">${o.cpu ?? "…"} %</div><div class="sub">${o.cores} cœurs · charge ${o.load.join(" / ")}${o.cpu_temp ? ` · ${o.cpu_temp.toFixed(0)}°C` : ""}</div>${bar(o.cpu || 0)}</div>
        <div class="card stat"><div class="label">${icon("memory-stick")}Mémoire</div><div class="value">${Math.round(o.mem.used / o.mem.total * 100)} %</div><div class="sub">${size(o.mem.used)} / ${size(o.mem.total)}</div>${bar(o.mem.used / o.mem.total * 100)}</div>
        <div class="card stat"><div class="label">${icon("activity")}Réseau</div><div class="value small" style="font-size:18px">${net ? `↓ ${size(net[1].rx)}/s<br>↑ ${size(net[1].tx)}/s` : "…"}</div><div class="sub">${net ? esc(net[0]) : ""}</div></div>
        <div class="card stat"><div class="label">${icon("clock")}En marche depuis</div><div class="value">${duration(o.uptime)}</div><div class="sub">${esc(o.hostname)} · noyau ${esc(o.kernel)}</div></div>
      </div>
      <div class="grid c2" style="margin-top:16px">
        <div class="card"><h3>${icon("history")}Sauvegardes</h3>${o.snapshot ? `<div class="row"><span class="dot ${o.snapshot.ok ? "ok" : "ko"}"></span><span class="grow">Dernier snapshot ${o.snapshot.ok ? "réussi" : "en échec"}</span><span class="faint small">${esc(new Date(o.snapshot.date).toLocaleString("fr-FR"))}</span></div><p class="faint small">${o.snapshot.snapshots} snapshot(s) conservé(s) · durée ${o.snapshot.seconds} s</p>` : `<p class="muted">Aucun snapshot.</p>`}
          <p class="faint small">Système : ${o.system.pct}% utilisés (${size(o.system.free)} libres sur le SSD) · ${o.photos} photos indexées</p></div>
        <div class="card"><h3>${icon("list")}Historique des alertes</h3>${o.alerts.filter((a) => !a.active).slice(0, 6).map((a) => `<div class="row small" style="padding:4px 0"><span class="dot ok"></span><span class="grow ellipsis">${esc(a.title)}</span><span class="faint">résolu ${ago(a.updated)}</span></div>`).join("") || `<p class="muted">Aucune alerte passée.</p>`}</div>
      </div>`;
    paintIcons(el);
    $("#rf", el).onclick = async () => { $("#rf", el).disabled = true; await post("/api/admin/refresh"); toast("Données actualisées (SMART inclus)", "success"); draw(); };
  };
  await draw();
  const t = setInterval(() => document.visibilityState === "visible" && draw().catch(() => {}), 30000);
  window.NAS.cleanup.push(() => clearInterval(t));
}

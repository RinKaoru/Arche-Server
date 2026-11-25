import { get, esc, icon, paintIcons, pageHeader, helpBanner, size, ago } from "../ui.js";

export default async function (el) {
  const o = await get("/api/admin/overview");
  const ts = o.tailscale || {};
  const tsOk = ts.state === "Running";
  el.innerHTML = pageHeader({ title: "Réseau & VPN", desc: "Les services du NAS et l'accès depuis l'extérieur via Tailscale." }) +
    helpBanner("network", "Réseau & VPN", `<p>Le NAS n'est <b>jamais exposé directement sur Internet</b>. Depuis l'extérieur, on passe par <b>Tailscale</b>, un VPN chiffré : seuls les appareils autorisés peuvent joindre le NAS.</p>
      <p><b>Pour ajouter un invité</b> (ex. un ami ou un membre de la famille) : dans la console Tailscale (login.tailscale.com → Machines → « nas » → Share…), envoie une invitation. La personne installe Tailscale, accepte, puis ouvre <b>${location.host}</b>. Elle ne voit <b>que le NAS</b>, pas le reste de ton réseau.</p>`) +
    `<div class="grid c2">
      <div class="card"><h3>${icon("server-cog")}Services</h3>${o.services.map((s) => `<div class="row" style="padding:6px 0"><span class="dot ${s.active ? "ok" : "ko"}"></span><span class="grow">${esc(s.label)}</span><span class="faint small mono">${esc(s.unit)}</span></div>`).join("")}</div>
      <div class="card"><h3>${icon("shield")}Tailscale (VPN)</h3>
        <div class="row" style="margin-bottom:10px"><span class="dot ${tsOk ? "ok" : "ko"}"></span><b class="grow">${tsOk ? "Connecté" : ts.state === "NeedsLogin" ? "En attente de connexion" : esc(ts.state || "Inconnu")}</b></div>
        ${ts.state === "NeedsLogin" && ts.auth_url ? `<p class="muted">Le NAS attend d'être relié à ton compte Tailscale. Ouvre ce lien et connecte-toi :</p><p><a class="btn primary" href="${esc(ts.auth_url)}" target="_blank" rel="noopener">${icon("external-link")}Relier le NAS à Tailscale</a></p>` : ""}
        ${tsOk ? `<dl class="kv small"><dt>Adresse VPN</dt><dd class="mono">${esc(ts.ip)}</dd><dt>Nom</dt><dd class="mono">${esc(ts.dns || "")}</dd><dt>Accès externe</dt><dd class="mono">${esc(location.origin)}</dd></dl>` : ""}</div>
    </div>
    <div class="card pad0" style="margin-top:16px"><div style="padding:16px 18px 6px"><h3 style="margin:0">${icon("laptop")}Appareils sur le VPN</h3></div>
      ${(ts.peers || []).length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Appareil</th><th class="hide-m">Adresse</th><th class="hide-m">Trafic</th><th>Statut</th></tr></thead><tbody>${ts.peers.map((p) => `<tr><td><b>${esc(p.name)}</b> ${p.shared ? `<span class="tag orange">Invité</span>` : ""}<div class="faint small">${esc(p.os || "")}</div></td>
        <td class="hide-m mono">${esc(p.ip || "")}</td><td class="hide-m small">↓ ${size(p.rx)} ↑ ${size(p.tx)}</td><td>${p.online ? `<span class="tag green">En ligne</span>` : `<span class="faint small">vu ${p.last_seen ? ago(Date.parse(p.last_seen) / 1000) : "?"}</span>`}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted" style="padding:0 18px 12px">Aucun autre appareil pour l'instant.</p>`}</div>
    <div class="card" style="margin-top:16px"><h3>${icon("activity")}Interfaces réseau</h3>${Object.entries(o.net || {}).map(([k, v]) => `<div class="row" style="padding:5px 0"><span class="mono grow">${esc(k)}</span><span class="small">↓ ${size(v.rx)}/s · ↑ ${size(v.tx)}/s</span></div>`).join("") || `<p class="muted">Mesure en cours…</p>`}</div>`;
  paintIcons(el);
}

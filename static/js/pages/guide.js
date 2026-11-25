// Aide : installation, accès, et à quoi sert chaque écran.
import { esc, icon, paintIcons } from "../ui.js";
import { visibleTools } from "../tools.js";

export default async function (el) {
  const me = window.NAS.me;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const card = (ic, c, t, html) => `<div class="card"><div class="qi ${c}" style="width:44px;height:44px;border-radius:14px;display:grid;place-items:center;margin-bottom:14px">${icon(ic)}</div><h3 style="margin-bottom:8px">${esc(t)}</h3><div class="muted" style="line-height:1.6">${html}</div></div>`;
  el.innerHTML = `<div class="hero"><h1>Aide</h1><p>Tout ce qu'il faut savoir, en version courte.</p></div>
    <div class="grid c2">
      ${card("smartphone", "g", "Installer l'app sur le téléphone", ios ? "Ouvre le NAS dans <b>Safari</b> → bouton <b>Partager</b> → <b>Sur l'écran d'accueil</b>. Ensuite, ouvre-la depuis l'icône et active les notifications." : "Ouvre le NAS dans <b>Chrome</b> → menu <b>⋮</b> → <b>Installer l'application</b>. Ensuite, active les notifications dans ton compte.")}
      ${card("house", "o", "À la maison", "Même adresse : <b>${location.host}</b>.<br>Sur un ordinateur, les dossiers s'ouvrent aussi comme des lecteurs réseau : <span class='mono'>\\\\nas.local</span> (Windows) ou <span class='mono'>smb://nas.local</span> (Mac).")}
      ${card("globe", "b", "En dehors de la maison", "Ouvre <b>${location.host}</b> depuis n'importe où. Par sécurité, la <b>double authentification</b> est obligatoire depuis l'extérieur (une app comme Google Authenticator). L'administration reste réservée à la maison.")}
      ${card("shield-check", "p", "Tes fichiers sont protégés", "Les disques sont en <b>RAID</b> : une panne de disque ne fait rien perdre. Chaque nuit, une <b>version</b> de chaque fichier est gardée (clic droit → Détails et versions). La <b>corbeille</b> ne se vide jamais toute seule.")}
    </div>
    <div class="section-title">Raccourcis clavier</div>
    <div class="card"><div class="grid c3" style="gap:10px 24px">${[["/", "Rechercher"], ["Double-clic", "Ouvrir"], ["Suppr", "Mettre à la corbeille"], ["F2", "Renommer"], ["Ctrl + A", "Tout sélectionner"], ["Maj + clic", "Sélectionner une plage"], ["⇧ N", "Nouveau dossier"], ["Espace", "Aperçu"], ["Échap", "Désélectionner"]].map(([k, l]) => `<div class="row"><span class="kbd">${k}</span><span class="muted small">${l}</span></div>`).join("")}</div></div>
    <div class="section-title">Les écrans</div>
    <div class="card pad0">${visibleTools(me).filter((t) => t.what && t.space === "me").map((t) => `<a class="list-item" href="${t.path}" data-link style="color:var(--text);text-decoration:none"><div class="ic info">${icon(t.icon)}</div><div class="grow"><b style="font-weight:600">${esc(t.label)}</b><div class="muted small">${esc(t.what)}</div></div>${icon("chevron-right")}</a>`).join("")}</div>`;
  paintIcons(el);
}

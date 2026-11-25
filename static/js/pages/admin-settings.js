import { get, put, post, esc, icon, paintIcons, $, pageHeader, toast, fail, switchEl } from "../ui.js";

export default async function (el) {
  const s = await get("/api/admin/settings");
  el.innerHTML = pageHeader({ title: "Réglages", desc: "Le nom de l'app, la sécurité et les notifications Discord." }) +
    `<form class="card" id="sf" style="max-width:640px"><label class="field"><span>Nom de l'app</span><input class="input" name="app_name" value="${esc(s.app_name)}" maxlength="30"><small>Affiché dans le menu, l'onglet et sous l'icône du téléphone (réinstalle l'app pour voir le nouveau nom).</small></label>
      <div class="perm-row"><div class="grow"><b>2FA obligatoire pour l'administration</b><span>Toute personne qui ouvre l'espace Administration doit avoir activé la double authentification.</span></div>${switchEl("require_2fa_admin", s.require_2fa_admin)}</div>
      <div class="actions" style="margin-top:14px"><button class="btn primary">Enregistrer</button></div></form>

    <h3 style="margin:28px 0 10px">${icon("message-circle")} Notifications Discord</h3>
    <form class="card" id="df" style="max-width:640px">
      <p class="faint small" style="margin-top:0">Les alertes importantes (disque, RAID, stockage plein, sauvegarde ratée…) sont aussi envoyées dans un salon Discord, et leur résolution aussi.
      Dans Discord : <b>Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l'URL</b>.</p>
      <label class="field"><span>URL du webhook ${s.discord_webhook ? `<span class="tag green">enregistré</span>` : ""}</span>
        <input class="input mono" name="hook" placeholder="${s.discord_webhook ? "•••••• (laisser vide pour garder l'actuel)" : "https://discord.com/api/webhooks/…"}" autocomplete="off"></label>
      <div class="actions"><button class="btn primary">Enregistrer</button>
        ${s.discord_webhook ? `<button type="button" class="btn" id="dtest">${icon("send")}Envoyer un test</button><button type="button" class="btn danger" id="ddel">Retirer</button>` : ""}</div>
    </form>

    </form>`;
  paintIcons(el);
  $("#sf", el).onsubmit = async (e) => {
    e.preventDefault();
    try { await put("/api/admin/settings", { app_name: e.target.app_name.value, require_2fa_admin: e.target.require_2fa_admin.checked }); toast("Réglages enregistrés", "success"); await window.NAS.refreshMe(); location.reload(); } catch (er) { fail(er); }
  };
  const reload = () => window.NAS.render();
  $("#df", el).onsubmit = async (e) => {
    e.preventDefault();
    const v = e.target.hook.value.trim();
    if (!v) return toast("Colle l'URL du webhook", "error");
    try { await put("/api/admin/settings", { discord_webhook: v }); toast("Webhook enregistré", "success"); reload(); } catch (er) { fail(er); }
  };
  const dt = $("#dtest", el); if (dt) dt.onclick = async () => { try { await post("/api/admin/discord-test"); toast("Message de test envoyé", "success"); } catch (er) { fail(er); } };
  const dd = $("#ddel", el); if (dd) dd.onclick = async () => { try { await put("/api/admin/settings", { discord_webhook: "" }); toast("Webhook retiré"); reload(); } catch (er) { fail(er); } };

}

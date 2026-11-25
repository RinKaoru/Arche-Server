import { get, post, del, api, esc, icon, otpField, bindOtp, paintIcons, $, pageHeader, toast, fail, modal, promptBox, confirmBox, menu, ago, date } from "../ui.js";

export default async function (el) {
  const me = window.NAS.me;
  const [sessions, devices] = await Promise.all([get("/api/me/sessions"), get("/api/me/2fa/devices")]);
  el.innerHTML = pageHeader({ title: "Mon compte", desc: "Sécurise ton compte et retrouve tes informations de connexion." }) +
    `<div class="grid c2">
      <div class="card"><h3>${icon("user-round")}Profil</h3><dl class="kv">
        <dt>Nom</dt><dd>${esc(me.display_name)}</dd><dt>Identifiant</dt><dd class="mono">${esc(me.username)}</dd>
        <dt>Rôle</dt><dd>${esc({ admin: "Administrateur", membre: "Membre de la famille", invite: "Invité" }[me.role])}</dd>
        <dt>Groupes</dt><dd>${me.groups.map((g) => `<span class="tag">${esc(g)}</span>`).join(" ") || "—"}</dd></dl></div>
      <div class="card"><h3>${icon("key-round")}Mot de passe</h3><p class="muted" style="margin-top:0">Le même mot de passe sert pour l'app et pour les lecteurs réseau sur PC/Mac.</p>
        <button class="btn" id="pw">${icon("pencil")}Changer mon mot de passe</button></div>
      <div class="card"><h3>${icon("shield-check")}Double authentification (2FA)</h3>
        ${devices.length ? `<p class="muted" style="margin-top:0">Un code à 6 chiffres est demandé à la connexion. N'importe lequel de tes appareils peut le fournir.</p>
          <div style="margin:0 -6px 12px">${devices.map((d) => `<div class="picker-row" style="cursor:default"><div class="qi g" style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center">${icon(/pc|ordi|mac|laptop|portable|bureau|windows/i.test(d.name) ? "monitor" : "smartphone")}</div>
            <div class="grow"><b style="font-weight:550">${esc(d.name)}</b><div class="faint small">Ajouté le ${date(d.created_at, false)} · ${d.last_used ? "utilisé " + ago(d.last_used) : "jamais utilisé"}</div></div>
            <button class="icon-btn" data-dev="${d.id}" data-name="${esc(d.name)}" title="Options">${icon("ellipsis-vertical")}</button></div>`).join("")}</div>
          <button class="btn" id="tfa-add">${icon("plus")}Ajouter un appareil</button>`
          : `<p><span class="tag ${me.admin_space ? "red" : ""}">Désactivée</span></p><p class="muted">${me.admin_space && me.require_2fa_admin ? "<b>Obligatoire pour accéder à l'administration.</b> " : ""}Obligatoire pour se connecter depuis l'extérieur de la maison. Tu pourras l'installer sur plusieurs appareils (téléphone, PC…).</p><button class="btn primary" id="tfa-add">${icon("shield-plus")}Activer la 2FA</button>`}</div>
      <div class="card"><h3>${icon("monitor")}Accès depuis un PC / Mac</h3>
        ${me.smb_enabled ? `<p class="muted" style="margin-top:0">Connecte-toi avec ton identifiant <b class="mono">${esc(me.username)}</b> et ton mot de passe.</p>
        <dl class="kv small"><dt>Windows</dt><dd class="mono">\\\\nas.local</dd><dt>Mac</dt><dd class="mono">smb://nas.local</dd><dt>Par IP</dt><dd class="mono">\\\\${location.hostname}</dd></dl>`
          : `<p class="muted">L'accès réseau (Samba) n'est pas activé pour ton compte. Utilise l'app web.</p>`}</div>
    </div>
    <div class="card pad0" style="margin-top:16px"><div style="padding:16px 18px 6px"><h3 style="margin:0">${icon("laptop")}Appareils connectés</h3><p class="muted small">Déconnecte un appareil perdu ou que tu ne reconnais pas.</p></div>
      ${sessions.map((s) => `<div class="list-item"><div class="ic info">${icon(/Mobile|Android|iPhone/.test(s.ua) ? "smartphone" : "monitor")}</div><div class="grow"><b>${esc(device(s.ua))}</b>${s.current ? ` <span class="tag green">Cet appareil</span>` : ""}<div class="faint small">${esc(s.ip || "")} · actif ${ago(s.last_seen)}</div></div>
        ${s.current ? "" : `<button class="btn sm" data-sid="${esc(s.id)}">Déconnecter</button>`}</div>`).join("")}</div>`;
  paintIcons(el);
  $("#pw", el).onclick = changePassword;
  $("#tfa-add", el).onclick = () => setup2fa();
  el.addEventListener("click", async (e) => {
    const dv = e.target.closest("[data-dev]");
    if (dv) return menu(dv, [
      { icon: "pencil", label: "Renommer", onClick: async () => { const n = await promptBox("Renommer l'appareil", "Nom", dv.dataset.name); if (n) { await api(`/api/me/2fa/devices/${dv.dataset.dev}`, { method: "PATCH", body: { name: n } }); window.NAS.render(); } } },
      { icon: "trash-2", label: "Retirer cet appareil", danger: true, onClick: () => removeDevice(dv.dataset.dev, dv.dataset.name, devices.length) },
    ]); const b = e.target.closest("[data-sid]"); if (b) { await del(`/api/me/sessions/${b.dataset.sid}`); toast("Appareil déconnecté", "success"); window.NAS.render(); } });
}

function device(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Appareil";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  return br ? `${br} sur ${os}` : os;
}

async function changePassword() {
  await modal({ title: "Changer mon mot de passe", body: `<label class="field"><span>Mot de passe actuel</span><input class="input" type="password" name="current" autocomplete="current-password"></label>
    <label class="field"><span>Nouveau mot de passe</span><input class="input" type="password" name="new" autocomplete="new-password"><small>10 caractères minimum.</small></label>
    <label class="field"><span>Confirmation</span><input class="input" type="password" name="new2" autocomplete="new-password"></label><p class="faint small">Tes autres appareils seront déconnectés.</p>`,
    actions: [{ label: "Annuler", cls: "ghost" }, { label: "Enregistrer", cls: "primary", primary: true, onClick: async (m) => {
      const v = (n) => $(`[name=${n}]`, m).value;
      if (v("new") !== v("new2")) { toast("Les deux mots de passe sont différents", "error"); return false; }
      await post("/api/me/password", { current: v("current"), new: v("new") }); toast("Mot de passe changé", "success");
    } }] });
}

export async function setup2fa(after) {
  const first = !window.NAS.me.totp_enabled;
  let r;
  try { r = await post("/api/me/2fa/setup"); } catch (e) { return fail(e); }
  const mobile = /Android|iPhone|iPad/.test(navigator.userAgent);
  const ok = await modal({ title: first ? "Activer la double authentification" : "Ajouter un appareil", body: `<ol class="muted" style="padding-left:18px;margin-top:0;line-height:1.7">
      <li>Ouvre une application d'authentification sur l'appareil :<br><span class="small">téléphone : Google Authenticator, Microsoft Authenticator, Aegis… · PC : 2FAS, Bitwarden, 1Password, KeePassXC, ou l'extension « Authenticator » du navigateur</span></li>
      <li>Scanne ce QR code${mobile ? ", ou appuie sur « Ouvrir dans l'app »" : ""} (sur PC, tu peux aussi coller la clé ci-dessous).</li><li>Entre le code à 6 chiffres affiché.</li></ol>
      <div class="qr">${r.svg}</div>
      <p class="faint small center" style="margin:0 0 6px">Clé : <span class="mono" data-select style="user-select:all">${esc(r.secret)}</span> <button class="btn ghost sm" type="button" id="cpk">${icon("copy")}</button></p>
      ${mobile ? `<p class="center" style="margin:0 0 12px"><a class="btn sm" href="${esc(r.uri)}">${icon("external-link")}Ouvrir dans l'app</a></p>` : ""}
      <div><label class="field"><span>Nom de l'appareil</span><input class="input" name="name" value="${mobile ? "Téléphone" : "PC"}" maxlength="40"></label>
      <div class="field"><span style="display:block;font-weight:550;margin-bottom:7px;font-size:13px">Les 6 chiffres affichés par ce nouvel appareil</span>${otpField({ id: "new-device-pin", name: "newpin", autofill: false })}</div></div>`,
    onOpen: (m) => { const o = bindOtp($("[data-otp]", m), () => m.querySelector("footer .primary").click()); m._otp = o; $("#cpk", m).onclick = () => navigator.clipboard?.writeText(r.secret).then(() => toast("Clé copiée", "success")); paintIcons(m); setTimeout(() => o.input.focus(), 50); },
    actions: [{ label: "Annuler", cls: "ghost" }, { label: first ? "Activer" : "Ajouter", cls: "primary", primary: true, onClick: async (m) => { await post("/api/me/2fa/enable", { code: m._otp.input.value, name: $("[name=name]", m).value }); return true; } }] });
  if (ok) {
    toast(first ? "Double authentification activée 🔐" : "Appareil ajouté 🔐", "success");
    await window.NAS.refreshMe(); window.NAS.me.need2fa = false; window.NAS.me.need_2fa_setup = false;
    after ? after() : window.NAS.render();
  }
}

async function removeDevice(id, name, count) {
  const last = count === 1;
  const ok = await modal({ title: last ? "Désactiver la 2FA ?" : `Retirer « ${name} » ?`,
    body: `<p class="muted" style="margin-top:0">${last ? "C'est ton dernier appareil : la double authentification sera désactivée. Depuis l'extérieur de la maison, il faudra la réactiver pour te connecter." : "Cet appareil ne pourra plus fournir de code. Tes autres appareils continuent de fonctionner."}</p>
      <label class="field"><span>Confirme avec ton mot de passe</span><input class="input" type="password" name="password" autocomplete="current-password"></label>`,
    actions: [{ label: "Annuler", cls: "ghost" }, { label: last ? "Désactiver" : "Retirer", cls: "danger solid", primary: true, onClick: async (m) => { await post(`/api/me/2fa/devices/${id}/delete`, { password: $("[name=password]", m).value }); return true; } }] });
  if (ok) { toast(last ? "2FA désactivée" : "Appareil retiré", "success"); await window.NAS.refreshMe(); window.NAS.render(); }
}

/** Écran affiché quand on ouvre l'administration sans 2FA (comme /setup-2fa). */
export function require2fa(el) {
  el.innerHTML = `<div class="empty" style="max-width:520px;margin:40px auto"><div class="ico">${icon("shield-alert")}</div><h3>Double authentification requise</h3>
    <p>Pour protéger le NAS, l'espace <b>Administration</b> exige que la double authentification soit activée sur ton compte. Ça prend une minute.</p>
    <button class="btn primary" id="go">${icon("shield-plus")}Activer la 2FA maintenant</button></div>`;
  paintIcons(el);
  $("#go", el).onclick = () => setup2fa(() => window.NAS.render());
}

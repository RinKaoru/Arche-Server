import { get, post, put, del, esc, icon, promptBox, paintIcons, $, $$, pageHeader, helpBanner, emptyState, chips, tabs, toast, fail, modal, confirmBox, drawer, switchEl, ago, copy, initials } from "../ui.js";

export default async function (el) {
  const me = window.NAS.me;
  let [users, groups, cfg] = await Promise.all([get("/api/admin/users"), get("/api/groups"), get("/api/admin/settings")]);
  let tab = "users", filter = "all";
  const ROLE = { admin: ["Administrateur", "orange"], membre: ["Membre", ""], invite: ["Invité", "yellow"] };
  const reload = async () => { [users, groups] = await Promise.all([get("/api/admin/users"), get("/api/groups")]); draw(); };

  const draw = () => {
    const list = users.filter((u) => filter === "all" || u.role === filter);
    el.innerHTML = pageHeader({ title: "Comptes & groupes", desc: "Qui peut se connecter au NAS, avec quel rôle et quelles permissions.",
      actions: tab === "users" ? `<button class="btn primary" id="new">${icon("user-plus")}Nouveau compte</button>` : `<button class="btn primary" id="newg">${icon("users")}Nouveau groupe</button>` }) +
      helpBanner("users", "Comptes & groupes", `<p><b>Administrateur</b> : accès à tout. <b>Membre</b> (famille) : ses fichiers, les dossiers partagés avec lui, peut créer des dossiers partagés. <b>Invité</b> : uniquement ce qu'on lui partage, jamais d'administration.</p>
        <p>Les <b>permissions</b> donnent à un membre l'accès à certains outils d'administration, sans en faire un admin. Les <b>groupes</b> simplifient le partage : donne accès à « Famille » plutôt qu'à chaque personne.</p>`) +
      tabs([{ value: "users", label: `Comptes (${users.length})`, icon: "user" }, { value: "groups", label: `Groupes (${groups.length})`, icon: "users" }], tab) +
      (tab === "users" ? chips([{ value: "all", label: "Tous", count: users.length }, ...Object.entries(ROLE).map(([k, [l]]) => ({ value: k, label: l + "s", count: users.filter((u) => u.role === k).length }))], filter) +
        `<div class="card pad0 table-wrap"><table class="table"><thead><tr><th>Compte</th><th>Rôle</th><th class="hide-m">Groupes</th><th class="hide-m">Sécurité</th><th class="hide-m">Dernière connexion</th><th></th></tr></thead><tbody>
        ${list.map((u) => `<tr data-id="${u.id}" style="${u.disabled ? "opacity:.5" : ""}"><td><div class="row"><div class="avatar">${esc(initials(u.display_name))}</div><div><b>${esc(u.display_name)}</b>${u.id === me.id ? ` <span class="faint small">(toi)</span>` : ""}<div class="faint small mono">${esc(u.username)}</div></div></div></td>
          <td><span class="tag ${ROLE[u.role][1]}">${ROLE[u.role][0]}</span>${u.disabled ? ` <span class="tag red">Désactivé</span>` : ""}</td>
          <td class="hide-m">${u.groups.map((g) => `<span class="tag" style="margin:1px">${esc(groups.find((x) => x.id === g)?.name || "?")}</span>`).join("")}</td>
          <td class="hide-m">${u.totp_enabled ? `<span class="tag green">${icon("shield-check")}2FA</span>` : `<span class="faint small">sans 2FA</span>`} ${u.must_change ? `<span class="tag yellow" title="Doit choisir son mot de passe">1ʳᵉ connexion</span>` : ""} ${u.smb_enabled ? `<span class="tag" title="Accès PC/Mac">${icon("monitor")}</span>` : ""}</td>
          <td class="hide-m small">${ago(u.last_login)}</td><td class="num"><button class="btn sm" data-edit>${icon("settings-2")}<span class="hide-m">Gérer</span></button></td></tr>`).join("")}</tbody></table></div>`
      : groups.length ? `<div class="grid c3">${groups.map((g) => `<div class="card" data-g="${g.id}"><div class="row"><div class="ficon folder">${icon("users")}</div><div class="grow"><b>${esc(g.name)}</b><div class="faint small">${esc(g.description || "")}</div></div><button class="btn sm icon" data-eg>${icon("pencil")}</button></div>
          <div style="margin-top:12px">${g.members.map((m) => `<span class="tag" style="margin:2px">${esc(users.find((u) => u.id === m)?.display_name || "?")}</span>`).join("") || `<span class="faint small">Aucun membre</span>`}</div></div>`).join("")}</div>`
        : emptyState("users", "Aucun groupe"));
    paintIcons(el);
    $(".tabs", el).onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; draw(); } };
    $(".chips", el) && ($(".chips", el).onclick = (e) => { const c = e.target.closest("[data-chip]"); if (c) { filter = c.dataset.chip; draw(); } });
    $("#new", el) && ($("#new", el).onclick = () => editUser(null));
    $("#newg", el) && ($("#newg", el).onclick = () => editGroup(null));
    el.onclick = (e) => {
      if (e.target.closest("[data-edit]")) editUser(users.find((u) => u.id === +e.target.closest("tr").dataset.id));
      if (e.target.closest("[data-eg]")) editGroup(groups.find((g) => g.id === +e.target.closest("[data-g]").dataset.g));
    };
  };

  const showPw = (u, pw) => modal({ title: "Mot de passe provisoire", body: `<p style="margin-top:0">Transmets ces informations à <b>${esc(u.display_name)}</b>. Il/elle devra choisir son propre mot de passe à la première connexion.</p>
    <dl class="kv"><dt>Adresse</dt><dd class="mono">${esc(window.NAS.me.public_url || location.origin)}</dd><dt>Identifiant</dt><dd class="mono">${esc(u.username)}</dd></dl><p></p><div class="pw-box">${esc(pw)}</div>
    <p class="faint small">Ce mot de passe ne sera plus affiché.</p>`, actions: [{ label: "Copier tout", icon: "copy", onClick: () => { copy(`Adresse : ${window.NAS.me.public_url || location.origin}\nIdentifiant : ${u.username}\nMot de passe provisoire : ${pw}`); return false; } }, { label: "J'ai noté", cls: "primary" }] });

  const editUser = (u) => {
    const isNew = !u;
    u = u || { username: "", display_name: "", role: "membre", perms: {}, groups: [], smb_enabled: true };
    const lockedAdmin = u.role === "admin" && me.role !== "admin";
    const d = drawer({
      title: isNew ? "Nouveau compte" : u.display_name,
      body: `<form id="uf">
        ${isNew ? `<label class="field"><span>Identifiant</span><input class="input mono" name="username" autocapitalize="none" pattern="[a-z][a-z0-9_-]{1,31}" required placeholder="marie"><small>Minuscules, chiffres, - et _. Ne peut pas être modifié ensuite.</small></label>` : `<p class="faint small mono" style="margin-top:0">Identifiant : ${esc(u.username)}</p>`}
        <label class="field"><span>Nom affiché</span><input class="input" name="display_name" value="${esc(u.display_name)}" placeholder="Marie"></label>
        <label class="field"><span>Rôle</span><select class="input" name="role" ${lockedAdmin ? "disabled" : ""}>${Object.entries(cfg.roles).filter(([k]) => k !== "admin" || me.role === "admin").map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <div class="perm-row"><div class="grow"><b>Accès depuis les PC/Mac</b><span>Lecteurs réseau (Samba), Time Machine</span></div>${switchEl("smb_enabled", u.smb_enabled)}</div>
        <hr><h3 style="margin:0 0 6px;font-size:15px">Groupes</h3>${groups.map((g) => `<div class="perm-row"><div class="grow"><b>${esc(g.name)}</b><span>${esc(g.description || "")}</span></div>${switchEl("g" + g.id, u.groups.includes(g.id))}</div>`).join("")}
        <div id="permbox"><hr><h3 style="margin:0 0 4px;font-size:15px">Permissions d'administration</h3><p class="faint small" style="margin:0 0 6px">Un administrateur les a toutes d'office. Un invité n'en a jamais.</p>
        ${Object.entries(cfg.permissions).map(([k, l]) => `<div class="perm-row"><div class="grow"><b>${esc(k)}</b><span>${esc(l)}</span></div>${switchEl("p_" + k, u.perms[k], "", u.role !== "membre")}</div>`).join("")}</div>
        ${!isNew ? `<hr><h3 style="margin:0 0 8px;font-size:15px">Dépannage</h3><div class="stack">
          <button type="button" class="btn" style="width:100%;justify-content:flex-start" id="ren" ${lockedAdmin ? "disabled" : ""}>${icon("at-sign")}Changer l'identifiant</button>
          <button type="button" class="btn" style="width:100%;justify-content:flex-start" id="rpw" ${lockedAdmin ? "disabled" : ""}>${icon("key-round")}Réinitialiser le mot de passe</button>
          ${u.totp_enabled ? `<button type="button" class="btn" style="width:100%;justify-content:flex-start" id="r2fa">${icon("shield-off")}Réinitialiser la 2FA (téléphone perdu)</button>` : ""}
          ${u.id !== me.id ? `<button type="button" class="btn" style="width:100%;justify-content:flex-start" id="dis">${icon(u.disabled ? "user-check" : "user-x")}${u.disabled ? "Réactiver le compte" : "Désactiver le compte"}</button>
          <button type="button" class="btn danger" style="width:100%;justify-content:flex-start" id="rm">${icon("trash-2")}Supprimer le compte</button>` : ""}</div>` : ""}
      </form>`,
      footer: `<button class="btn ghost" id="cancel">Annuler</button><button class="btn primary" id="save">${isNew ? "Créer le compte" : "Enregistrer"}</button>`,
    });
    const f = $("#uf", d);
    f.role.onchange = () => $$("[name^=p_]", d).forEach((i) => (i.disabled = f.role.value !== "membre"));
    $("#cancel", d).onclick = () => d.close();
    $("#save", d).onclick = async () => {
      const body = { display_name: f.display_name.value.trim(), smb_enabled: f.smb_enabled.checked, groups: groups.filter((g) => f["g" + g.id].checked).map((g) => g.id),
        perms: Object.fromEntries(Object.keys(cfg.permissions).map((k) => [k, f["p_" + k].checked])) };
      if (!lockedAdmin) body.role = f.role.value;
      try {
        if (isNew) { body.username = f.username.value.trim().toLowerCase(); const r = await post("/api/admin/users", body); d.close(); await reload(); showPw({ ...body }, r.password); }
        else { await put(`/api/admin/users/${u.id}`, body); toast("Compte enregistré", "success"); d.close(); reload(); }
      } catch (e) { fail(e); }
    };
    if (isNew) return;
    $("#ren", d).onclick = async () => {
      const n = await promptBox("Changer l'identifiant", "Nouvel identifiant (minuscules, chiffres, - et _)", u.username, { ok: "Renommer" });
      if (!n || n === u.username) return;
      if (!(await confirmBox("Changer l'identifiant ?", `<b>${esc(u.username)}</b> devient <b>${esc(n.toLowerCase())}</b>. Le mot de passe, les fichiers, la 2FA et les partages sont conservés. Il faudra se connecter avec le nouvel identifiant (app et ordinateurs).`, { ok: "Renommer" }))) return;
      try { await post(`/api/admin/users/${u.id}/rename`, { username: n }); toast("Identifiant modifié", "success"); d.close(); if (u.id === me.id) { await window.NAS.refreshMe(); } reload(); } catch (e) { fail(e); }
    };
    $("#rpw", d).onclick = async () => { if (await confirmBox("Réinitialiser le mot de passe ?", `Un mot de passe provisoire sera généré. ${esc(u.display_name)} sera déconnecté(e) partout.`)) { try { const r = await post(`/api/admin/users/${u.id}/reset-password`); d.close(); showPw(u, r.password); reload(); } catch (e) { fail(e); } } };
    $("#r2fa", d) && ($("#r2fa", d).onclick = async () => { if (await confirmBox("Réinitialiser la 2FA ?", "La personne pourra se connecter avec son seul mot de passe, puis réactiver la 2FA.")) { await post(`/api/admin/users/${u.id}/reset-2fa`); toast("2FA réinitialisée", "success"); d.close(); reload(); } });
    $("#dis", d) && ($("#dis", d).onclick = async () => { try { await put(`/api/admin/users/${u.id}`, { disabled: !u.disabled }); toast(u.disabled ? "Compte réactivé" : "Compte désactivé", "success"); d.close(); reload(); } catch (e) { fail(e); } });
    $("#rm", d) && ($("#rm", d).onclick = async () => {
      if (!(await confirmBox("Supprimer ce compte ?", `Le compte <b>${esc(u.username)}</b> sera supprimé. Ses fichiers personnels sont <b>conservés</b> dans un dossier « archive-${esc(u.username)} » visible par les administrateurs.`, { danger: true, ok: "Supprimer" }))) return;
      try { await del(`/api/admin/users/${u.id}`); toast("Compte supprimé", "success"); d.close(); reload(); } catch (e) { fail(e); }
    });
  };

  const editGroup = (g) => {
    const isNew = !g;
    g = g || { name: "", description: "", members: [] };
    const d = drawer({ title: isNew ? "Nouveau groupe" : g.name,
      body: `<form id="gf"><label class="field"><span>Nom</span><input class="input" name="name" value="${esc(g.name)}" required></label><label class="field"><span>Description</span><input class="input" name="description" value="${esc(g.description)}"></label>
        <hr><h3 style="margin:0 0 6px;font-size:15px">Membres</h3>${users.map((u) => `<div class="perm-row"><div class="avatar">${esc(initials(u.display_name))}</div><div class="grow"><b>${esc(u.display_name)}</b><span>${esc(u.username)}</span></div>${switchEl("u" + u.id, g.members.includes(u.id))}</div>`).join("")}</form>`,
      footer: `${!isNew ? `<button class="btn danger" id="rm" style="margin-right:auto">${icon("trash-2")}</button>` : ""}<button class="btn primary" id="save">${isNew ? "Créer" : "Enregistrer"}</button>` });
    const f = $("#gf", d);
    $("#save", d).onclick = async () => {
      const body = { name: f.name.value.trim(), description: f.description.value, members: users.filter((u) => f["u" + u.id].checked).map((u) => u.id) };
      try { isNew ? await post("/api/admin/groups", body) : await put(`/api/admin/groups/${g.id}`, body); toast("Groupe enregistré", "success"); d.close(); reload(); } catch (e) { fail(e); }
    };
    $("#rm", d) && ($("#rm", d).onclick = async () => { if (await confirmBox("Supprimer le groupe ?", "Les accès accordés via ce groupe seront retirés.", { danger: true, ok: "Supprimer" })) { await del(`/api/admin/groups/${g.id}`); d.close(); reload(); } });
  };
  draw();
}

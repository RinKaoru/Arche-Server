// Page publique d'un lien (/s/<token>) : transfert, dossier, fichier, ou dépôt de fichiers — sans compte.
import { api, get, qs, upload, esc, icon, paintIcons, $, size, vkind, fileIcon, ring } from "../ui.js";

export default async function (root, token) {
  const frame = (inner) => {
    root.innerHTML = `<div class="login-wrap"><div class="pub">${inner}<div class="pub-foot"><div class="logo">${icon("cloud")}</div>Envoyé avec Arche</div></div></div>`;
    paintIcons(root);
  };
  const raw = (p, d) => `/api/public/${token}/raw?${qs({ path: p, dl: d || undefined })}`;
  const until = (ts) => { const d = Math.ceil((ts - Date.now() / 1000) / 86400); return d <= 1 ? "expire bientôt" : `expire dans ${d} jours`; };

  const load = async (path = "") => {
    let info;
    try { info = await get(`/api/public/${token}?${qs({ path })}`); }
    catch (e) {
      if (e.detail === "password_required") return askPw(path);
      return frame(`<div class="card"><div class="empty"><div class="ico">${icon("link-2-off")}</div><h3>Ce lien n'est plus disponible</h3><p>Il a peut-être expiré ou été supprimé. Demande un nouveau lien à la personne qui te l'a envoyé.</p></div></div>`);
    }
    if (info.allow_upload) return dropPage(info);
    if (!info.dir) {
      const k = vkind({ name: info.name, kind: info.kind });
      const prev = info.kind === "image" ? `<img src="${raw("")}" style="width:100%;display:block">` : info.kind === "video" ? `<video src="${raw("")}" controls playsinline style="width:100%;display:block;background:#000"></video>` : info.kind === "audio" ? `<div style="padding:0 30px 20px"><audio src="${raw("")}" controls style="width:100%"></audio></div>` : "";
      return frame(`<div class="card">${prev}<div class="ph"><div class="row" style="gap:14px"><span class="fic k-${k}" style="width:48px;height:48px;background:var(--elev-3);border-radius:14px">${icon(fileIcon(k))}</span>
        <div class="grow"><h1 style="font-size:20px">${esc(info.name)}</h1><span class="muted small">${size(info.size)} · partagé par ${esc(info.author)}${info.expires_at ? " · " + until(info.expires_at) : ""}</span></div></div></div>
        <div class="pa"><a class="btn primary lg block" href="${raw("", 1)}">${icon("download")}Télécharger</a></div></div>`);
    }
    const parts = info.path ? info.path.split("/") : [];
    const transfer = info.kind === "transfer" && !info.path;
    frame(`<div class="card"><div class="ph">
        ${transfer ? `<div class="qi p" style="width:54px;height:54px;border-radius:17px;display:grid;place-items:center;margin-bottom:18px">${icon("send")}</div>` : ""}
        <h1>${esc(info.name)}</h1>
        <span class="muted">${transfer ? `${esc(info.author)} t'a envoyé ${info.total_count} fichier${info.total_count > 1 ? "s" : ""} · ${size(info.total_size)}` : `Partagé par ${esc(info.author)}`}${info.expires_at ? " · " + until(info.expires_at) : ""}</span>
        ${info.message ? `<div class="msg">${esc(info.message)}</div>` : ""}
        ${parts.length ? `<div class="crumbs small" style="margin:16px 0 0"><a data-p="">${esc(info.name)}</a>${parts.map((p, i) => `${icon("chevron-right")}<a data-p="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("")}</div>` : ""}</div>
      <div class="pf">${info.items.map((it) => { const k = vkind(it); return `<div class="xitem" data-p="${esc(it.path)}" ${it.dir ? "data-dir" : ""} style="cursor:pointer">
        <span class="fic k-${k}" style="background:var(--elev-3);border-radius:10px">${icon(fileIcon(k))}${it.kind === "image" ? `<img loading="lazy" src="/api/public/${token}/thumb?${qs({ path: it.path })}" data-fb>` : ""}</span>
        <div class="grow"><b class="ellipsis" style="display:block;font-weight:500">${esc(it.name)}</b><span class="faint small">${it.dir ? "Dossier" : size(it.size)}</span></div>
        ${it.dir ? icon("chevron-right") : `<a class="icon-btn" href="${raw(it.path, 1)}" title="Télécharger">${icon("download")}</a>`}</div>`; }).join("") || `<p class="muted center" style="padding:20px">Dossier vide</p>`}</div>
      <div class="pa"><a class="btn primary lg block" href="/api/public/${token}/zip?${qs({ path: info.path })}">${icon("download")}Tout télécharger</a></div></div>`);
    root.querySelector(".pub").addEventListener("click", (e) => {
      const p = e.target.closest("[data-p]"); if (!p || e.target.closest("a.icon-btn")) return;
      if (p.classList.contains("xitem") && !p.hasAttribute("data-dir")) return window.open(raw(p.dataset.p), "_blank");
      load(p.dataset.p);
    }, { once: true });
  };

  const dropPage = (info) => {
    let files = [];
    const draw = () => {
      frame(`<div class="card"><div class="ph"><div class="qi b" style="width:54px;height:54px;border-radius:17px;display:grid;place-items:center;margin-bottom:18px">${icon("inbox")}</div>
        <h1>${esc(info.name)}</h1><span class="muted">${esc(info.author)} te demande des fichiers${info.expires_at ? " · " + until(info.expires_at) : ""}</span>
        ${info.message ? `<div class="msg">${esc(info.message)}</div>` : ""}</div>
        <div class="drop" id="drop">${icon("upload-cloud")}<div style="margin-top:10px"><b>${files.length ? `${files.length} fichier${files.length > 1 ? "s" : ""} · ${size(files.reduce((a, f) => a + f.size, 0))}` : "Choisis ou glisse tes fichiers"}</b></div><div class="faint small">${files.length ? "Clique pour en ajouter d'autres" : "Photos, vidéos, documents… aucune limite"}</div></div>
        <div class="pa"><label class="field"><span>Ton prénom</span><input class="input" id="who" placeholder="Pour que ${esc(info.author)} sache qui envoie" maxlength="40"></label>
        <button class="btn primary lg block" id="send" ${files.length ? "" : "disabled"}>Envoyer</button></div></div>`);
      const drop = $("#drop");
      drop.onclick = () => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.onchange = () => { files.push(...i.files); draw(); }; i.click(); };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); files.push(...e.dataTransfer.files); draw(); };
      $("#send").onclick = go;
    };
    const go = async () => {
      const who = $("#who").value.trim() || "Anonyme";
      const total = files.reduce((a, f) => a + f.size, 0); let sent = 0, ok = 0;
      const prog = (p) => { root.querySelector(".pa").innerHTML = `<div class="row" style="justify-content:center;gap:14px;padding:6px 0">${ring(p, 40)}<div><b>Envoi en cours… ${Math.round(p * 100)}%</b><div class="faint small">${size(sent)} sur ${size(total)}</div></div></div>`; };
      prog(0);
      for (const f of files) {
        try { await upload(`/api/public/${token}/upload?` + qs({ name: f.name, sender: who }), f, (p) => prog((sent + f.size * p) / Math.max(1, total))); ok++; } catch {}
        sent += f.size;
      }
      await api(`/api/public/${token}/done`, { method: "POST", body: { sender: who, count: ok } }).catch(() => {});
      frame(`<div class="card"><div class="ph center" style="padding:44px 30px"><div class="qi g" style="width:72px;height:72px;border-radius:24px;display:grid;place-items:center;margin:0 auto 18px">${icon("check")}</div>
        <h1>Merci ${esc(who === "Anonyme" ? "" : who)} !</h1><p class="muted">${ok} fichier${ok > 1 ? "s" : ""} envoyé${ok > 1 ? "s" : ""} à ${esc(info.author)}.${ok < files.length ? ` ${files.length - ok} n'ont pas pu être envoyés.` : ""}</p>
        <button class="btn" data-reload style="margin-top:12px">Envoyer d'autres fichiers</button></div></div>`);
    };
    draw();
  };

  const askPw = (path) => {
    frame(`<form class="card" id="pf"><div class="ph center"><div class="qi o" style="width:60px;height:60px;border-radius:20px;display:grid;place-items:center;margin:0 auto 16px">${icon("lock")}</div>
      <h1 style="font-size:22px">Lien protégé</h1><p class="muted" style="margin:0">Entre le mot de passe communiqué par l'expéditeur.</p></div>
      <div class="pa"><div class="err" style="color:var(--red);margin-bottom:10px" hidden></div><input class="input" type="password" name="pw" autofocus placeholder="Mot de passe" style="margin-bottom:12px"><button class="btn primary lg block">Ouvrir</button></div></form>`);
    $("#pf").onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/api/public/${token}/auth`, { method: "POST", body: { password: e.target.pw.value } }); load(path); }
      catch (er) { const x = $(".err"); x.textContent = er.message; x.hidden = false; }
    };
  };
  load();
}

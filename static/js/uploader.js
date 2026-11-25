// File d'envoi globale (façon Drive) : panneau en bas à droite, progression, reprise des erreurs.
import { esc, icon, paintIcons, upload, qs, size, ring, get } from "./ui.js";

let queue = [], panel = null, running = false, collapsed = false;

/** files: [{file, name}] ; target: {share, path} | {url: (q)=>string} */
export function enqueue(files, target) {
  if (!files.length) return;
  for (const f of files) queue.push({ ...f, target, progress: 0, status: "wait" });
  collapsed = false; draw();
  if (!running) run();
}

/** Destination par défaut : le dossier ouvert, sinon l'espace perso. */
export async function defaultTarget() {
  const cur = window.NAS.currentFolder;
  if (cur && cur.level === "write") return { share: cur.share, path: cur.path, label: cur.label };
  const shares = await get("/api/shares");
  const perso = shares.find((s) => s.kind === "personal" && s.owner_id === window.NAS.me.id);
  return { share: perso.id, path: "", label: "Mes fichiers" };
}

/** Ouvre le sélecteur de fichiers (ou de dossier) puis envoie. */
export async function pick(dir = false, target) {
  const t = target || await defaultTarget();
  const inp = document.createElement("input");
  inp.type = "file"; inp.multiple = true; if (dir) inp.webkitdirectory = true;
  inp.onchange = () => enqueue([...inp.files].map((f) => ({ file: f, name: dir ? f.webkitRelativePath || f.name : f.name })), t);
  inp.click();
}

function draw() {
  if (!queue.length) { panel?.remove(); panel = null; return; }
  if (!panel) { panel = document.createElement("div"); panel.className = "uploads"; document.body.append(panel); }
  const done = queue.filter((q) => q.status === "ok").length, errs = queue.filter((q) => q.status === "err").length;
  const total = queue.reduce((a, q) => a + q.file.size, 0), sent = queue.reduce((a, q) => a + q.file.size * (q.status === "ok" ? 1 : q.progress), 0);
  const title = running ? `Importation de ${queue.length - done - errs} élément${queue.length - done - errs > 1 ? "s" : ""}` :
    errs ? `${done} importé${done > 1 ? "s" : ""}, ${errs} échec${errs > 1 ? "s" : ""}` : `${done} élément${done > 1 ? "s" : ""} importé${done > 1 ? "s" : ""}`;
  panel.innerHTML = `<header>${running ? ring(sent / Math.max(1, total)) : errs ? `<span class="err">${icon("circle-alert")}</span>` : `<span class="ok">${icon("circle-check")}</span>`}
    <span class="grow">${esc(title)}</span>
    ${errs && !running ? `<button class="icon-btn" data-retry title="Réessayer">${icon("rotate-cw")}</button>` : ""}
    <button class="icon-btn" data-col title="${collapsed ? "Déplier" : "Replier"}">${icon(collapsed ? "chevron-up" : "chevron-down")}</button>
    ${running ? "" : `<button class="icon-btn" data-x title="Fermer">${icon("x")}</button>`}</header>
    <div class="list2" ${collapsed ? "hidden" : ""}>${queue.slice(-60).reverse().map((q) => `<div class="item">
      <span class="fic k-file">${icon("file")}</span><div class="grow"><div class="ellipsis">${esc(q.name.split("/").pop())}</div>
      <div class="faint small">${q.status === "err" ? `<span class="err">${esc(q.error)}</span>` : q.status === "up" ? `${size(q.file.size * q.progress)} sur ${size(q.file.size)}` : size(q.file.size)}${q.target.label ? " · " + esc(q.target.label) : ""}</div></div>
      ${q.status === "ok" ? `<span class="ok">${icon("circle-check")}</span>` : q.status === "up" ? ring(q.progress) : q.status === "err" ? `<span class="err">${icon("circle-alert")}</span>` : `<span class="faint">${icon("clock")}</span>`}</div>`).join("")}</div>`;
  paintIcons(panel);
  panel.onclick = (e) => {
    if (e.target.closest("[data-col]")) { collapsed = !collapsed; draw(); }
    if (e.target.closest("[data-x]")) { queue = []; draw(); }
    if (e.target.closest("[data-retry]")) { queue.forEach((q) => q.status === "err" && (q.status = "wait")); run(); }
  };
}

async function run() {
  running = true; draw();
  let last = 0;
  for (const q of queue) {
    if (q.status !== "wait") continue;
    q.status = "up"; draw();
    const url = q.target.url ? q.target.url(q) : "/api/files/upload?" + qs({ share: q.target.share, path: q.target.path, name: q.name, mtime: q.file.lastModified });
    try {
      await upload(url, q.file, (p) => { q.progress = p; if (Date.now() - last > 200) { last = Date.now(); draw(); } });
      q.status = "ok";
    } catch (e) { q.status = "err"; q.error = e.message; }
    draw();
  }
  running = false; draw();
  window.dispatchEvent(new Event("nas:uploaded"));
}

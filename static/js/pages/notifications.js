import { get, post, del, esc, icon, paintIcons, $, pageHeader, helpBanner, emptyState, toast, fail, ago } from "../ui.js";

const ICON = { error: "circle-alert", warning: "triangle-alert", success: "circle-check", info: "bell" };

export default async function (el) {
  const list = await get("/api/notifications");
  const pushState = await pushStatus();
  el.innerHTML = pageHeader({ title: "Notifications", desc: "Ton historique de notifications et les alertes sur ton téléphone.",
    actions: list.some((n) => !n.read) ? `<button class="btn" id="all">${icon("check-check")}Tout marquer comme lu</button>` : list.length ? `<button class="btn ghost" id="clear">${icon("trash-2")}Effacer les lues</button>` : "" }) +
    `<div class="card" style="margin-bottom:18px"><div class="row" style="flex-wrap:wrap"><div class="ic info" style="width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:var(--orange-soft)">${icon("smartphone")}</div>
      <div class="grow" style="min-width:200px"><b>Notifications sur cet appareil</b><div class="muted small">${esc(pushState.text)}</div></div>
      ${pushState.can ? `<button class="btn ${pushState.on ? "" : "primary"}" id="push">${pushState.on ? "Envoyer un test" : "Activer"}</button>` : ""}</div></div>` +
    (list.length ? `<div class="card pad0">${list.map((n) => `<div class="list-item ${n.read ? "" : "unread"}" data-id="${n.id}" data-link="${esc(n.link || "")}" style="cursor:${n.link ? "pointer" : "default"}">
      <div class="ic ${n.level}">${icon(ICON[n.level] || "bell")}</div><div class="grow"><b>${esc(n.title)}</b>${n.body ? `<div class="muted small">${esc(n.body)}</div>` : ""}</div>
      <span class="faint small" style="white-space:nowrap">${ago(n.created_at)}</span>${n.read ? "" : `<span class="dot" style="background:var(--orange)"></span>`}</div>`).join("")}</div>`
      : emptyState("bell-off", "Aucune notification", "Tu seras prévenu ici des partages, alertes et événements importants."));
  paintIcons(el);
  $("#all", el) && ($("#all", el).onclick = async () => { await post("/api/notifications/read", { all: true }); window.NAS.refreshMe(); window.NAS.render(); });
  $("#clear", el) && ($("#clear", el).onclick = async () => { await del("/api/notifications"); window.NAS.render(); });
  el.querySelector(".card.pad0")?.addEventListener("click", async (e) => {
    const it = e.target.closest("[data-id]"); if (!it) return;
    await post("/api/notifications/read", { id: +it.dataset.id }).catch(() => {});
    window.NAS.refreshMe();
    if (it.dataset.link) window.NAS.navigate(it.dataset.link); else { it.classList.remove("unread"); it.querySelector(".dot")?.remove(); }
  });
  $("#push", el) && ($("#push", el).onclick = async () => {
    try {
      if (!pushState.on) { await enablePush(); toast("Notifications activées sur cet appareil", "success"); window.NAS.render(); }
      else { await post("/api/push/test"); toast("Notification de test envoyée", "success"); }
    } catch (e) { fail(e); }
  });
}

async function pushStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return { can: false, text: !window.isSecureContext ? "Il faut accéder au NAS en HTTPS (adresse de ton NAS) pour recevoir des notifications." :
      ios ? "Sur iPhone : ajoute d'abord l'app à l'écran d'accueil (Partager → Sur l'écran d'accueil), puis ouvre-la depuis l'icône." : "Ce navigateur ne gère pas les notifications push." };
  }
  if (Notification.permission === "denied") return { can: false, text: "Les notifications sont bloquées dans les réglages du navigateur pour ce site." };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? { can: true, on: true, text: "Activées : tu recevras les alertes même quand l'app est fermée." } : { can: true, on: false, text: "Reçois les alertes et partages même quand l'app est fermée." };
}

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Permission refusée.");
  const { key } = await get("/api/push/key");
  const reg = await navigator.serviceWorker.ready;
  const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - key.length % 4) % 4)), (c) => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  await post("/api/push/subscribe", sub.toJSON());
}

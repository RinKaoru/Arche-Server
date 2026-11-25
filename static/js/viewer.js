// Visionneuse plein écran : photos (zoom molette / pincement / double-clic, déplacement), vidéos (copie lisible préparée
// par le NAS quand le navigateur ne sait pas lire l'original), audio, PDF, texte. Clavier, glisser, diaporama, infos.
import { get, esc, icon, paintIcons, size, date, folderUrl } from "./ui.js";

const HEVC_OK = (() => { try { return document.createElement("video").canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') === "probably"; } catch { return false; } })();
const WEB_IMG = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;   // les autres (HEIC, TIFF…) : aperçu 1280 px préparé par le NAS
const fullDate = (ts) => { const s = new Date(ts * 1000).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }); return s[0].toUpperCase() + s.slice(1); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const touchUI = () => matchMedia("(hover: none)").matches;

/** list: [{name, kind, size?, mtime?, taken_at?, w?, h?, lat?, lon?, share?, path?, share_name?}]
 *  urls: {raw(it, dl), thumb(it)? (1280 px), small(it)? (miniature déjà en cache), text(it)?, play(it, hevc)?}
 *  extra: {share(it)?, album(it)?} */
export function viewer(list, idx, urls, extra = {}) {
  const multi = list.length > 1;
  const v = document.createElement("div"); v.className = "viewer"; v.tabIndex = -1;
  v.innerHTML = `<div class="vw-main">
      <div class="vw-stage"></div>
      ${multi ? `<button class="nav-btn prev" data-p title="Précédent (←)">${icon("chevron-left")}</button><button class="nav-btn next" data-n title="Suivant (→)">${icon("chevron-right")}</button>` : ""}
      <div class="vw-zoom"><button data-zo title="Zoom arrière (−)">${icon("minus")}</button><button class="pct" data-z0 title="Ajuster à l'écran (0)"></button><button data-zi title="Zoom avant (+)">${icon("plus")}</button></div>
      <header class="vw-top"><button class="icon-btn" data-x title="Fermer (Échap)">${icon("arrow-left")}</button>
        <div class="vw-ttl"><b></b><span></span></div>
        ${multi ? `<button class="icon-btn hide-m" data-show title="Diaporama">${icon("play")}</button>` : ""}
        ${extra.album ? `<button class="icon-btn" data-album title="Ajouter à un album">${icon("book-plus")}</button>` : ""}
        ${extra.share ? `<button class="icon-btn" data-share title="Partager par lien">${icon("link")}</button>` : ""}
        <a class="icon-btn" data-dl download title="Télécharger">${icon("download")}</a>
        <button class="icon-btn" data-info title="Informations (I)">${icon("info")}</button>
        <button class="icon-btn hide-m" data-fs title="Plein écran (F)">${icon("maximize")}</button>
      </header>
    </div>
    <aside class="vw-info"><header><b>Informations</b><button class="icon-btn" data-info title="Fermer">${icon("x")}</button></header><div class="vw-info-body"></div></aside>`;
  document.body.append(v);
  paintIcons(v);
  document.body.style.overflow = "hidden";
  const stage = v.querySelector(".vw-stage"), zoomBar = v.querySelector(".vw-zoom");
  let cur = null, closed = false, show = null, idleT = null, lastTouch = 0;

  // ------------------------------------------------------------------ affichage d'un élément
  function render(dir = 0) {
    const it = list[idx];
    if (cur) leave(cur, dir);
    const slide = document.createElement("div"); slide.className = "vw-slide" + (dir ? (dir > 0 ? " in-next" : " in-prev") : "");
    stage.append(slide);
    cur = { it, slide, s: 1, tx: 0, ty: 0, fit: null, nat: null };
    stage.classList.toggle("is-img", it.kind === "image");
    if (it.kind === "image") renderImage(cur);
    else if (it.kind === "video") renderVideo(cur);
    else if (it.kind === "audio") slide.innerHTML = `<div class="vw-card"><div class="ico">${icon("audio-lines")}</div><h3>${esc(it.name)}</h3><audio src="${urls.raw(it)}" controls autoplay></audio></div>`;
    else if (it.kind === "pdf") slide.innerHTML = `<iframe src="${urls.raw(it)}" title="${esc(it.name)}"></iframe>`;
    else if (it.kind === "text") { slide.innerHTML = `<pre>Chargement…</pre>`; loadText(cur); }
    else slide.innerHTML = `<div class="vw-card"><div class="ico">${icon("file")}</div><h3>Pas d'aperçu pour ce fichier</h3><a class="btn primary" href="${urls.raw(it, 1)}" download>${icon("download")}Télécharger</a></div>`;
    paintIcons(slide);
    const when = it.taken_at || it.mtime;
    v.querySelector(".vw-ttl b").textContent = it.name;
    v.querySelector(".vw-ttl span").textContent = [when ? date(when) : "", multi ? `${idx + 1} sur ${list.length}` : ""].filter(Boolean).join(" · ");
    v.querySelector("[data-dl]").href = urls.raw(it, 1);
    updZoom();
    if (v.classList.contains("info-open")) fillInfo();
    preload();
    if (show) schedule();
  }
  function leave(c, dir) {
    c.slide.querySelectorAll("video, audio").forEach((m) => { m.pause(); m.removeAttribute("src"); m.load(); });
    clearTimeout(c.poll); c.gone = true;
    c.slide.style.transform = "";
    c.slide.classList.add(dir > 0 ? "out-prev" : dir < 0 ? "out-next" : "out");
    setTimeout(() => c.slide.remove(), 260);
  }
  const go = (d) => { if (!multi) return; idx = (idx + d + list.length) % list.length; render(d); };

  // ------------------------------------------------------------------ photos
  function renderImage(c) {
    const { it, slide } = c;
    const img = new Image(); img.className = "vw-img"; img.alt = ""; img.draggable = false; img.decoding = "async";
    c.img = img; slide.append(img);
    const full = urls.raw(it), steps = [urls.small?.(it), urls.thumb?.(it), (!urls.thumb || WEB_IMG.test(it.name)) ? full : null].filter(Boolean);
    let shown = -1;
    // la miniature (déjà en cache) s'affiche tout de suite, puis l'aperçu 1280 px, puis l'original
    steps.forEach((src, i) => {
      const p = new Image();
      p.onload = () => {
        if (c.gone || i <= shown) return;
        shown = i; img.src = src; c.ratio = p.naturalWidth / p.naturalHeight;
        if (src === full) c.nat = { w: p.naturalWidth, h: p.naturalHeight };
        layout(c);
        if (src === full && v.classList.contains("info-open")) fillInfo();
      };
      p.onerror = () => { if (i === steps.length - 1 && shown < 0 && !c.gone) { slide.innerHTML = `<div class="vw-card"><div class="ico">${icon("image-off")}</div><h3>Impossible d'afficher cette image</h3></div>`; paintIcons(slide); } };
      p.src = src;
    });
  }
  function layout(c) {
    if (!c?.img || !c.ratio) return;
    const r = stage.getBoundingClientRect(), mob = touchUI() || r.width < 700;
    const bw = r.width - (mob ? 0 : 144), bh = r.height - (mob ? 0 : 96);
    let w = bw, h = bw / c.ratio; if (h > bh) { h = bh; w = bh * c.ratio; }
    if (c.nat && c.nat.w < w) { w = c.nat.w; h = c.nat.h; }   // une petite image n'est jamais agrandie
    c.fit = { w, h }; c.img.style.width = w + "px"; c.img.style.height = h + "px";
    apply(c, false); updZoom();
  }
  const natW = (c) => {
    if (c.nat) return c.nat.w;
    if (c.it.w && c.it.h) return c.ratio >= 1 ? Math.max(c.it.w, c.it.h) : Math.min(c.it.w, c.it.h);
    return c.fit?.w || 1;
  };
  const maxS = (c) => Math.max(4, (natW(c) / (c.fit?.w || 1)) * 2);
  function apply(c, anim = true) {
    if (!c?.img || !c.fit) return;
    const r = stage.getBoundingClientRect(), mx = Math.max(0, (c.fit.w * c.s - r.width) / 2), my = Math.max(0, (c.fit.h * c.s - r.height) / 2);
    c.tx = clamp(c.tx, -mx, mx); c.ty = clamp(c.ty, -my, my);
    c.img.classList.toggle("anim", anim);
    c.img.style.transform = `translate(${c.tx}px, ${c.ty}px) scale(${c.s})`;
    stage.classList.toggle("zoomed", c.s > 1.01);
  }
  function zoomAt(c, s, mx, my, anim = true, from = null) {
    if (!c?.img || !c.fit) return;
    const f = from || { s: c.s, tx: c.tx, ty: c.ty }, rect = c.img.getBoundingClientRect();
    const ox = rect.left + rect.width / 2 - c.tx, oy = rect.top + rect.height / 2 - c.ty;   // centre de l'image au repos
    if (mx == null) { mx = ox; my = oy; }
    s = clamp(s, 1, maxS(c));
    c.tx = (mx - ox) - (s / f.s) * (mx - ox - f.tx); c.ty = (my - oy) - (s / f.s) * (my - oy - f.ty); c.s = s;
    if (s <= 1.001) { c.s = 1; c.tx = c.ty = 0; }
    apply(c, anim); updZoom();
  }
  function updZoom() {
    const on = cur?.it.kind === "image" && cur.fit;
    zoomBar.classList.toggle("on", !!on);
    if (on) zoomBar.querySelector(".pct").textContent = Math.round((cur.s * cur.fit.w / natW(cur)) * 100) + " %";
  }
  const toggleZoom = (x, y) => { if (cur.s > 1.01) return zoomAt(cur, 1); const one = natW(cur) / cur.fit.w; zoomAt(cur, one > 1.3 ? Math.min(one, maxS(cur)) : 2.5, x, y); };

  // ------------------------------------------------------------------ vidéos
  function renderVideo(c) {
    const { it, slide } = c;
    const vid = document.createElement("video"); vid.controls = true; vid.playsInline = true; vid.preload = "auto";
    if (urls.thumb) vid.poster = urls.thumb(it);
    const ov = document.createElement("div"); ov.className = "vw-prep";
    slide.append(vid, ov); c.vid = vid;
    vid.addEventListener("ended", () => { if (show && cur === c) go(1); });
    loadVideo(c, HEVC_OK);
  }
  async function loadVideo(c, hevc) {
    const { it, vid } = c, ov = c.slide.querySelector(".vw-prep");
    if (!urls.play) { vid.src = urls.raw(it); vid.play().catch(() => {}); return; }
    let st;
    try { st = await get(urls.play(it, hevc ? 1 : 0)); } catch { st = { mode: "native", url: urls.raw(it) }; }
    if (c.gone) return;
    if (st.mode === "native" || st.ready) {
      ov.className = "vw-prep"; ov.innerHTML = "";
      if (st.mode === "native" && hevc) {   // le navigateur pensait savoir lire l'original : sinon, on bascule sur la copie
        const bad = () => { if (!c.gone && !c.fell) { c.fell = true; loadVideo(c, false); } };
        vid.addEventListener("error", bad, { once: true });
        vid.addEventListener("loadedmetadata", () => { if (!vid.videoWidth) bad(); }, { once: true });
      }
      vid.src = st.url; vid.play().catch(() => {});
      return;
    }
    ov.className = "vw-prep on";
    if (st.error) {
      ov.innerHTML = `<div class="vw-card"><div class="ico">${icon("film")}</div><h3>Cette vidéo ne peut pas être lue ici</h3><p class="faint">Tu peux la télécharger pour la regarder sur ton appareil.</p><a class="btn primary" href="${urls.raw(it, 1)}" download>${icon("download")}Télécharger</a></div>`;
      return paintIcons(ov);
    }
    const pct = Math.round((st.progress || 0) * 100);
    ov.innerHTML = `<div class="vw-card"><div class="spinner"></div><h3>Préparation de la vidéo…</h3><p class="faint">${pct ? `${pct} %` : "Conversion dans un format lisible par ce navigateur."}</p><div class="vw-bar"><i style="width:${pct}%"></i></div></div>`;
    c.poll = setTimeout(() => loadVideo(c, false), 1200);
  }

  async function loadText(c) {
    if (!urls.text) return;
    try { const r = await get(urls.text(c.it)); if (!c.gone) c.slide.querySelector("pre").textContent = r.text + (r.truncated ? "\n\n… (aperçu tronqué)" : ""); }
    catch (e) { if (!c.gone) c.slide.querySelector("pre").textContent = e.message; }
  }
  function preload() {
    if (!multi) return;
    [list[(idx + 1) % list.length], list[(idx - 1 + list.length) % list.length]].forEach((it) => {
      if (it.kind !== "image") return;
      if (urls.thumb) new Image().src = urls.thumb(it);
      if (!urls.thumb || WEB_IMG.test(it.name)) setTimeout(() => { if (!closed) new Image().src = urls.raw(it); }, 500);
    });
  }

  // ------------------------------------------------------------------ informations
  function fillInfo() {
    const it = list[idx], body = v.querySelector(".vw-info-body"), when = it.taken_at || it.mtime;
    const dim = cur?.nat ? [cur.nat.w, cur.nat.h] : it.w && it.h ? [it.w, it.h] : null;
    const dir = (it.path || "").split("/").slice(0, -1).join("/");
    const row = (ic, a, b = "") => `<div class="vw-row">${icon(ic)}<div><div>${a}</div>${b ? `<div class="faint small">${b}</div>` : ""}</div></div>`;
    const where = it.share_name ? (it.share_name.startsWith("perso-") ? "Mes fichiers" : it.share_name) : "Dossier";
    body.innerHTML = [
      when ? row("calendar", esc(fullDate(when)), it.taken_at ? "Prise de vue" : "Dernière modification") : "",
      row(it.kind === "video" ? "film" : it.kind === "image" ? "image" : "file", esc(it.name),
        [dim ? `${dim[0]} × ${dim[1]}` : "", dim && it.kind === "image" ? `${(dim[0] * dim[1] / 1e6).toFixed(1)} MP` : "", it.size ? size(it.size) : ""].filter(Boolean).join(" · ")),
      it.share != null && it.path ? row("folder", esc(where) + (dir ? " › " + esc(dir.split("/").join(" › ")) : ""), `<a href="#" data-folder>Ouvrir le dossier</a>`) : "",
      it.lat != null && it.lon != null ? row("map-pin", `${(+it.lat).toFixed(5)}, ${(+it.lon).toFixed(5)}`,
        `<a href="https://www.openstreetmap.org/?mlat=${+it.lat}&mlon=${+it.lon}#map=16/${+it.lat}/${+it.lon}" target="_blank" rel="noopener noreferrer">Voir sur une carte</a>`) : "",
    ].join("");
    paintIcons(body);
  }
  function toggleInfo() { v.classList.toggle("info-open"); if (v.classList.contains("info-open")) fillInfo(); setTimeout(() => layout(cur), 240); }

  // ------------------------------------------------------------------ diaporama
  function schedule() { clearTimeout(show); show = cur?.it.kind === "video" ? -1 : setTimeout(() => go(1), 4000); }
  function slideshow(on) {
    const b = v.querySelector("[data-show]"); if (!b || !!on === !!show) return;
    if (on) schedule(); else { clearTimeout(show); show = null; }
    b.innerHTML = icon(on ? "pause" : "play"); b.title = on ? "Arrêter le diaporama" : "Diaporama"; paintIcons(b);
    if (on && !document.fullscreenElement) v.requestFullscreen?.().catch(() => {});
  }

  // ------------------------------------------------------------------ fermeture / historique (le bouton retour ferme la visionneuse)
  function teardown() {
    if (closed) return; closed = true;
    if (cur) leave(cur, 0);
    clearTimeout(show); clearTimeout(idleT);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.removeEventListener("keydown", key); window.removeEventListener("resize", onResize);
    v.classList.add("closing"); setTimeout(() => v.remove(), 160);
    document.body.style.overflow = "";
    if (window.NAS?.onPop === onPop) window.NAS.onPop = null;
  }
  const onPop = () => { teardown(); return true; };
  function close() {
    teardown();
    if (history.state?.viewer) { if (window.NAS) window.NAS.onPop = () => { window.NAS.onPop = null; return true; }; history.back(); }
  }
  history.pushState({ ...history.state, viewer: 1 }, "");
  if (window.NAS) window.NAS.onPop = onPop;

  // ------------------------------------------------------------------ commandes
  v.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-x]")) close();
    else if (t.closest("[data-p]")) { slideshow(false); go(-1); }
    else if (t.closest("[data-n]")) { slideshow(false); go(1); }
    else if (t.closest("[data-share]")) extra.share(list[idx]);
    else if (t.closest("[data-album]")) extra.album(list[idx]);
    else if (t.closest("[data-info]")) toggleInfo();
    else if (t.closest("[data-show]")) slideshow(!show);
    else if (t.closest("[data-fs]")) document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.();
    else if (t.closest("[data-zi]")) zoomAt(cur, cur.s * 1.5);
    else if (t.closest("[data-zo]")) zoomAt(cur, cur.s / 1.5);
    else if (t.closest("[data-z0]")) zoomAt(cur, 1);
    else if (t.closest("[data-folder]")) {
      e.preventDefault(); const it = list[idx], dir = it.path.split("/").slice(0, -1).join("/");
      teardown(); history.replaceState({ ...history.state, viewer: 0 }, ""); window.NAS?.navigate(folderUrl(it, dir, it.name));
    }
  });
  document.addEventListener("fullscreenchange", function fs() {
    if (closed) return document.removeEventListener("fullscreenchange", fs);
    const b = v.querySelector("[data-fs]"); if (b) { b.innerHTML = icon(document.fullscreenElement ? "minimize" : "maximize"); paintIcons(b); }
  });
  const key = (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName) || document.querySelector(".modal-back")) return;
    const k = e.key;
    if (k === "Escape") { if (cur?.s > 1.01) zoomAt(cur, 1); else close(); }
    else if (k === "ArrowRight") { slideshow(false); go(1); }
    else if (k === "ArrowLeft") { slideshow(false); go(-1); }
    else if (k === "i" || k === "I") toggleInfo();
    else if (k === "f" || k === "F") v.querySelector("[data-fs]")?.click();
    else if (k === "+" || k === "=") zoomAt(cur, cur.s * 1.5);
    else if (k === "-") zoomAt(cur, cur.s / 1.5);
    else if (k === "0") zoomAt(cur, 1);
    else if (k === " " && cur?.vid && document.activeElement !== cur.vid) { e.preventDefault(); cur.vid.paused ? cur.vid.play() : cur.vid.pause(); }
    else return;
    e.preventDefault(); wake();
  };
  document.addEventListener("keydown", key);
  const onResize = () => { if (cur) { cur.s = 1; cur.tx = cur.ty = 0; layout(cur); } };
  window.addEventListener("resize", onResize);

  // l'interface s'efface quand la souris ne bouge plus (comme un lecteur de photos)
  function wake() {
    v.classList.remove("idle"); clearTimeout(idleT);
    if (!touchUI()) idleT = setTimeout(() => { if (!v.querySelector(".vw-top:hover, .vw-zoom:hover, .nav-btn:hover, .vw-info:hover")) v.classList.add("idle"); }, 2600);
  }
  v.addEventListener("mousemove", wake);

  // molette = zoom à l'endroit du pointeur
  stage.addEventListener("wheel", (e) => {
    if (cur?.it.kind !== "image") return;
    e.preventDefault();
    const d = e.deltaY * (e.deltaMode === 1 ? 30 : 1);
    zoomAt(cur, cur.s * Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY, false);
  }, { passive: false });
  stage.addEventListener("dblclick", (e) => { if (cur?.img && Date.now() - lastTouch > 800) toggleZoom(e.clientX, e.clientY); });

  // pointeurs : déplacer l'image zoomée, pincer, glisser pour changer de photo, glisser vers le bas pour fermer
  const pts = new Map(); let g = null, lastTap = 0, tapT = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") lastTouch = Date.now();
    if (e.target.closest("video, audio, iframe, pre, .vw-card, button, a")) return;
    if (e.pointerType === "mouse" && (e.button !== 0 || !(cur?.s > 1.01))) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    slideshow(false);
    if (pts.size === 2 && cur?.img) {
      const [a, b] = [...pts.values()];
      g = { pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, from: { s: cur.s, tx: cur.tx, ty: cur.ty }, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      cur.slide.style.transform = "";
    } else if (pts.size === 1) g = { x: e.clientX, y: e.clientY, tx: cur?.tx || 0, ty: cur?.ty || 0, t: Date.now(), axis: null, touch: e.pointerType !== "mouse" };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pinch) {
      const [a, b] = [...pts.values()]; if (!b) return;
      zoomAt(cur, g.from.s * Math.hypot(a.x - b.x, a.y - b.y) / g.d, g.mx, g.my, false, g.from);
      return;
    }
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (cur?.s > 1.01) { cur.tx = g.tx + dx; cur.ty = g.ty + dy; apply(cur, false); stage.classList.add("panning"); return; }
    if (!g.touch) return;
    if (!g.axis && Math.hypot(dx, dy) > 10) g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : dy > 0 ? "y" : "none";
    if (g.axis === "x" && multi) cur.slide.style.transform = `translateX(${dx}px)`;
    if (g.axis === "y") { cur.slide.style.transform = `translateY(${Math.max(0, dy)}px) scale(${1 - Math.min(0.25, Math.max(0, dy) / 1500)})`; v.style.setProperty("--vw-bg", String(Math.max(0.35, 1 - Math.max(0, dy) / 500))); }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId); stage.classList.remove("panning");
    if (!g) return;
    if (g.pinch) { if (pts.size === 0) { g = null; if (cur.s < 1.05) zoomAt(cur, 1); } return; }
    const dx = e.clientX - g.x, dy = e.clientY - g.y, dt = Date.now() - g.t, s = cur.slide.style;
    if (g.axis === "x" && multi && (Math.abs(dx) > stage.clientWidth * 0.2 || (Math.abs(dx) > 40 && dt < 250))) go(dx < 0 ? 1 : -1);
    else if (g.axis === "y" && (dy > 140 || (dy > 60 && dt < 250))) close();
    else if (g.axis) { s.transition = "transform .2s"; s.transform = ""; v.style.removeProperty("--vw-bg"); setTimeout(() => (s.transition = ""), 220); }
    if (g.touch && !g.axis && Math.hypot(dx, dy) < 10 && dt < 300) {   // toucher : double = zoom, simple = masquer/afficher l'interface
      if (Date.now() - lastTap < 300) { clearTimeout(tapT); lastTap = 0; if (cur?.img) toggleZoom(e.clientX, e.clientY); }
      else { lastTap = Date.now(); tapT = setTimeout(() => v.classList.toggle("bare"), 300); }
    }
    g = null;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  // glisser sur une vidéo / un document (là où l'on ne capte pas les pointeurs)
  let sx = null;
  stage.addEventListener("touchstart", (e) => { sx = e.target.closest("video, iframe, pre, .vw-card") ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!sx || !multi) return; const dx = e.changedTouches[0].clientX - sx.x, dy = e.changedTouches[0].clientY - sx.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1); sx = null;
  });

  render();
  wake();
  v.focus({ preventScroll: true });
  return close;
}
export const PREVIEWABLE = ["image", "video", "audio", "pdf", "text"];

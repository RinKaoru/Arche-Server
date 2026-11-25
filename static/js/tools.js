// Catalogue unique des écrans : menu, guide et aide lisent ce fichier.
export const TOOLS = [
  // ---------------- Mon espace (navigation principale, façon Drive)
  { id: "home", space: "me", sec: 0, label: "Accueil", path: "/", icon: "house", mobile: true, what: "Tes raccourcis, fichiers récents et dernières photos." },
  { id: "files", space: "me", sec: 0, label: "Mes fichiers", short: "Fichiers", path: "/fichiers", icon: "hard-drive", mobile: true, what: "Ton espace personnel : toi seul y as accès." },
  { id: "shared", space: "me", sec: 0, label: "Partagés", path: "/partages", icon: "users", mobile: true, what: "Les dossiers communs : famille, projets, médias…" },
  { id: "recent", space: "me", sec: 0, label: "Récents", path: "/recents", icon: "clock", what: "Ce que tu as importé ou modifié dernièrement." },
  { id: "starred", space: "me", sec: 0, label: "Favoris", path: "/favoris", icon: "star", what: "Les fichiers et dossiers marqués d'une étoile." },
  { id: "photos", space: "me", sec: 1, label: "Photos", path: "/photos", icon: "images", mobile: true, what: "Toutes tes photos par date, et la sauvegarde du téléphone." },
  { id: "albums", space: "me", sec: 1, label: "Albums", path: "/albums", icon: "book-image", what: "Des sélections de photos à partager." },
  { id: "transfers", space: "me", sec: 2, label: "Transferts", path: "/transferts", icon: "send", what: "Envoyer des fichiers par lien, ou en recevoir de quelqu'un sans compte." },
  { id: "sync", space: "me", sec: 2, label: "Synchronisation", short: "Synchro", path: "/synchro", icon: "folder-sync", what: "Tes PC Windows et les photos de ton téléphone Android sauvegardés automatiquement." },
  { id: "trash", space: "me", sec: 2, label: "Corbeille", path: "/corbeille", icon: "trash-2", what: "Les éléments supprimés, récupérables à tout moment." },
  // écrans accessibles depuis le menu du compte
  { id: "notifications", space: "me", hidden: true, label: "Notifications", path: "/notifications", icon: "bell", badge: "unread", mobile: false },
  { id: "account", space: "me", hidden: true, label: "Mon compte", path: "/compte", icon: "user-round" },
  { id: "guide", space: "me", hidden: true, label: "Aide", path: "/guide", icon: "life-buoy" },

  // ---------------- Administration
  { id: "overview", space: "admin", group: "Supervision", label: "Vue d'ensemble", short: "État", mobile: true, path: "/admin", icon: "gauge", perm: "viewMonitoring", badge: "alerts",
    what: "L'état du NAS en un coup d'œil : alertes, stockage, RAID, disques, services." },
  { id: "disks", space: "admin", group: "Supervision", label: "Disques & RAID", short: "Disques", mobile: true, path: "/admin/disques", icon: "hard-drive", perm: "viewMonitoring", what: "La santé de chaque disque et du RAID." },
  { id: "network", space: "admin", group: "Supervision", label: "Réseau & VPN", path: "/admin/reseau", icon: "network", perm: "viewMonitoring", what: "Services, Tailscale et appareils connectés." },
  { id: "users", space: "admin", group: "Gestion", label: "Comptes & groupes", short: "Comptes", mobile: true, path: "/admin/comptes", icon: "users", perm: "manageUsers", what: "Comptes, rôles, permissions et groupes." },
  { id: "allshares", space: "admin", group: "Gestion", label: "Tous les partages", path: "/admin/partages", icon: "folder-lock", perm: "manageShares", what: "Tous les dossiers partagés et leurs accès." },
  { id: "snapshots", space: "admin", group: "Sauvegardes", label: "Snapshots", short: "Sauvegardes", mobile: true, path: "/admin/snapshots", icon: "history", perm: "manageBackups", what: "Les copies quotidiennes du NAS." },
  { id: "github", space: "admin", group: "Sauvegardes", label: "GitHub", path: "/admin/github", icon: "github", perm: "manageBackups", what: "Copie quotidienne de vos dépôts GitHub." },
  { id: "docker", space: "admin", group: "Projets", label: "Docker", path: "/admin/docker", icon: "container", perm: "manageDocker", what: "Les conteneurs de vos projets." },
  { id: "audit", space: "admin", group: "Sécurité", label: "Journal d'audit", path: "/admin/audit", icon: "scroll-text", perm: "viewLogs", what: "Qui a fait quoi et quand." },
  { id: "settings", space: "admin", group: "Sécurité", label: "Réglages", path: "/admin/reglages", icon: "settings", admin: true, what: "Nom de l'app, sécurité et notifications Discord." },
];

export function visibleTools(me) {
  return TOOLS.filter((t) => {
    if (t.admin && me.role !== "admin") return false;
    if (t.perm && !me.perms[t.perm]) return false;
    if (t.member && me.role === "invite") return false;
    return true;
  });
}

// ============================================================
//  TikTok Top 3 Donations — Serveur Railway
//  Variable d'environnement à définir sur Railway :
//    TIKTOK_USERNAME = ton_pseudo_tiktok  (sans @)
// ============================================================

const http                           = require("http");
const { WebcastPushConnection }      = require("tiktok-live-connector");
const WebSocket                      = require("ws");

const PORT     = process.env.PORT     || 8765;
const USERNAME = process.env.TIKTOK_USERNAME;

if (!USERNAME) {
  console.error("❌  Variable TIKTOK_USERNAME manquante dans Railway.");
  process.exit(1);
}

// ── Serveur HTTP (health-check pour Railway) ──────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("TikTok Top3 Donations — OK");
});

// ── Serveur WebSocket sur le même port ────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`✅  Serveur actif sur le port ${PORT}`);
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ── Classement en mémoire ─────────────────────────────────────
const donations = {};

function getTop3() {
  return Object.entries(donations)
    .map(([name, coins]) => ({ name, coins }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3);
}

// ── Connexion TikTok Live ─────────────────────────────────────
function connectTikTok() {
  const tiktok = new WebcastPushConnection(USERNAME, {
    processInitialData  : false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    clientParams: { app_language: "fr-FR", device_platform: "web" },
  });

  tiktok.connect()
    .then(() => console.log(`🔴  Connecté au live de @${USERNAME}`))
    .catch((err) => {
      console.error("❌  Connexion impossible :", err.message);
      console.log("⏳  Nouvelle tentative dans 30 s…");
      setTimeout(connectTikTok, 30_000);
    });

  // Cadeaux / dons
  tiktok.on("gift", (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return; // streak pas terminé

    const pseudo = data.uniqueId || data.nickname || "anonyme";
    const coins  = (data.diamondCount || data.gift?.diamond_count || 1)
                   * (data.repeatCount || 1);

    donations[pseudo] = (donations[pseudo] || 0) + coins;
    console.log(`🎁  ${pseudo} → ${coins} coins  (total: ${donations[pseudo]})`);

    broadcast({
      type : "gift",
      donor: { name: pseudo, coins: donations[pseudo] },
      top3 : getTop3(),
    });
  });

  tiktok.on("disconnected", () => {
    console.log("⚠️  Déconnecté — reconnexion dans 15 s…");
    setTimeout(connectTikTok, 15_000);
  });

  tiktok.on("error", (err) => console.error("Erreur TikTok :", err));
}

connectTikTok();

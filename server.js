const http = require("http");
const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const USERNAME = process.env.TIKTOK_USERNAME || "";

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("TikTok Top3 — OK");
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur actif sur le port " + PORT);
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

const donations = {};
const avatars = {};

function getTop3() {
  return Object.entries(donations)
    .map(([name, coins]) => ({ name, coins, avatar: avatars[name] || null }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3);
}

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "reset") {
        Object.keys(donations).forEach(k => delete donations[k]);
        Object.keys(avatars).forEach(k => delete avatars[k]);
        broadcast({ type: "reset" });
        console.log("Classement remis a zero");
      }
    } catch(e) {}
  });
});

function connectTikTok() {
  if (!USERNAME) {
    console.log("TIKTOK_USERNAME non defini — serveur pret");
    return;
  }

  const tiktok = new WebcastPushConnection(USERNAME, {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
  });

  tiktok.connect()
    .then(() => console.log("Connecte au live de @" + USERNAME))
    .catch((err) => {
      console.log("Connexion impossible : " + err.message);
      setTimeout(connectTikTok, 30000);
    });

  tiktok.on("gift", (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const pseudo = data.uniqueId || "anonyme";
    const coins = (data.diamondCount || 1) * (data.repeatCount || 1);
    donations[pseudo] = (donations[pseudo] || 0) + coins;
    if (data.profilePictureUrl && !avatars[pseudo]) {
      avatars[pseudo] = data.profilePictureUrl;
    }
    console.log(pseudo + " -> " + coins + " coins (total: " + donations[pseudo] + ")");
    broadcast({
      type: "gift",
      donor: { name: pseudo, coins: donations[pseudo], avatar: avatars[pseudo] || null },
      top3: getTop3(),
    });
  });

  tiktok.on("disconnected", () => {
    console.log("Deconnecte — reconnexion dans 15s...");
    setTimeout(connectTikTok, 15000);
  });

  tiktok.on("error", (err) => console.log("Erreur : " + err.message));
}

connectTikTok();

const http = require("http");
const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");
 
const PORT         = process.env.PORT         || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";
 
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("TikTok Multi-Panel OK");
});
 
const wss = new WebSocket.Server({ server: httpServer });
 
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur actif port " + PORT);
});
 
// ── Données par room ──────────────────────────────────────────
const rooms = {};
 
function getRoom(username) {
  if (!rooms[username]) {
    rooms[username] = { donations: {}, avatars: {}, tiktok: null };
    connectTikTok(username);
  }
  return rooms[username];
}
 
function getTop3(username) {
  const r = rooms[username];
  if (!r) return [];
  return Object.entries(r.donations)
    .map(([name, coins]) => ({ name, coins, avatar: r.avatars[name] || null }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3);
}
 
function broadcastRoom(username, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.room === username) {
      c.send(msg);
    }
  });
}
 
function resetRoom(username) {
  const r = rooms[username];
  if (!r) return;
  r.donations = {};
  r.avatars   = {};
  broadcastRoom(username, { type: "reset" });
  console.log("Reset @" + username);
}
 
// ── WebSocket ─────────────────────────────────────────────────
wss.on("connection", socket => {
  socket.room = null;
 
  socket.on("message", raw => {
    try {
      const msg = JSON.parse(raw);
 
      if (msg.type === "join" && msg.username) {
        socket.room = msg.username;
        getRoom(msg.username);
        socket.send(JSON.stringify({
          type: "sync",
          top3: getTop3(msg.username)
        }));
        console.log("Panel rejoint: @" + msg.username);
      }
 
      if (msg.type === "reset" && msg.secret === ADMIN_SECRET && msg.username) {
        resetRoom(msg.username);
      }
 
      if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
 
    } catch(e) {}
  });
 
  socket.on("error", () => {});
});
 
// ── TikTok ────────────────────────────────────────────────────
function connectTikTok(username) {
  const r = rooms[username];
  if (!r) return;
 
  const tiktok = new WebcastPushConnection(username, {
    processInitialData  : false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
  });
 
  r.tiktok = tiktok;
 
  tiktok.connect()
    .then(() => {
      console.log("Connecte @" + username);
      broadcastRoom(username, { type: "status", online: true });
    })
    .catch(err => {
      console.log("Erreur @" + username + ": " + err.message + " retry 30s");
      setTimeout(() => connectTikTok(username), 30000);
    });
 
  tiktok.on("gift", data => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const pseudo = data.uniqueId || "anonyme";
    const coins  = (data.diamondCount || 1) * (data.repeatCount || 1);
    r.donations[pseudo] = (r.donations[pseudo] || 0) + coins;
    if (data.profilePictureUrl && !r.avatars[pseudo]) {
      r.avatars[pseudo] = data.profilePictureUrl;
    }
    console.log("[@" + username + "] " + pseudo + " +" + coins);
    broadcastRoom(username, {
      type : "gift",
      donor: { name: pseudo, coins: r.donations[pseudo], avatar: r.avatars[pseudo] || null },
      top3 : getTop3(username),
    });
  });
 
  tiktok.on("disconnected", () => {
    console.log("Deconnecte @" + username + " retry 15s");
    setTimeout(() => connectTikTok(username), 15000);
  });
 
  tiktok.on("error", err => {
    console.log("[@" + username + "] " + err.message);
  });
}
 

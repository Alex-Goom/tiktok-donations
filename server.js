const http = require("http");
const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");

const PORT         = process.env.PORT         || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";

// ── HTTP + WebSocket ───────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // GET /rooms?secret=xxx  → liste des rooms
  if (req.method === "GET" && url.pathname === "/rooms") {
    if (url.searchParams.get("secret") !== ADMIN_SECRET) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const list = Object.entries(rooms).map(([username, r]) => ({
      username,
      connected: r.tiktok ? r.tiktok._isConnected || false : false,
      top3: getTop3(username),
    }));
    res.end(JSON.stringify(list));
    return;
  }

  // POST /room  body: { username, secret }
  if (req.method === "POST" && url.pathname === "/room") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { username, secret } = JSON.parse(body);
        if (secret !== ADMIN_SECRET) { res.writeHead(403); res.end("Forbidden"); return; }
        if (!username)               { res.writeHead(400); res.end("username required"); return; }
        createRoom(username);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, username }));
      } catch(e) { res.writeHead(400); res.end("Bad JSON"); }
    });
    return;
  }

  // POST /reset  body: { username, secret }
  if (req.method === "POST" && url.pathname === "/reset") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { username, secret } = JSON.parse(body);
        if (secret !== ADMIN_SECRET) { res.writeHead(403); res.end("Forbidden"); return; }
        resetRoom(username);
        res.writeHead(200); res.end("ok");
      } catch(e) { res.writeHead(400); res.end("Bad JSON"); }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("TikTok Multi-Panel — OK");
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(PORT, "0.0.0.0", () =>
  console.log("Serveur actif sur le port " + PORT)
);

// ── Rooms ──────────────────────────────────────────────────────
const rooms = {};  // { username: { donations, avatars, tiktok } }

function getRoom(username) {
  if (!rooms[username]) rooms[username] = { donations: {}, avatars: {}, tiktok: null };
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
    if (c.readyState === WebSocket.OPEN && c.room === username) c.send(msg);
  });
}

function resetRoom(username) {
  const r = rooms[username];
  if (!r) return;
  Object.keys(r.donations).forEach(k => delete r.donations[k]);
  Object.keys(r.avatars).forEach(k => delete r.avatars[k]);
  broadcastRoom(username, { type: "reset" });
  console.log("Reset: @" + username);
}

function createRoom(username) {
  if (rooms[username] && rooms[username].tiktok) {
    console.log("Room déjà active: @" + username); return;
  }
  getRoom(username);
  connectTikTok(username);
  console.log("Room créée: @" + username);
}

// ── WebSocket — abonnement à une room ─────────────────────────
wss.on("connection", socket => {
  socket.room = null;

  socket.on("message", raw => {
    try {
      const msg = JSON.parse(raw);

      // join: le panel s'abonne à une room
      if (msg.type === "join" && msg.username) {
        socket.room = msg.username;
        // envoyer le top3 actuel immédiatement
        socket.send(JSON.stringify({ type: "sync", top3: getTop3(msg.username) }));
      }

      // reset depuis admin via WS
      if (msg.type === "reset" && msg.username && msg.secret === ADMIN_SECRET) {
        resetRoom(msg.username);
      }

    } catch(e) {}
  });
});

// ── TikTok connexion par room ──────────────────────────────────
function connectTikTok(username) {
  const r = getRoom(username);

  const tiktok = new WebcastPushConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
  });

  r.tiktok = tiktok;

  tiktok.connect()
    .then(() => {
      console.log("Connecté: @" + username);
      broadcastRoom(username, { type: "status", online: true });
    })
    .catch(err => {
      console.log("Erreur @" + username + ": " + err.message + " — retry 30s");
      setTimeout(() => connectTikTok(username), 30000);
    });

  tiktok.on("gift", data => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const pseudo = data.uniqueId || "anonyme";
    const coins  = (data.diamondCount || 1) * (data.repeatCount || 1);
    r.donations[pseudo] = (r.donations[pseudo] || 0) + coins;
    if (data.profilePictureUrl && !r.avatars[pseudo]) r.avatars[pseudo] = data.profilePictureUrl;
    console.log("[@" + username + "] " + pseudo + " -> " + coins + " coins");
    broadcastRoom(username, {
      type : "gift",
      donor: { name: pseudo, coins: r.donations[pseudo], avatar: r.avatars[pseudo] || null },
      top3 : getTop3(username),
    });
  });

  tiktok.on("disconnected", () => {
    console.log("Déconnecté @" + username + " — retry 15s");
    setTimeout(() => connectTikTok(username), 15000);
  });

  tiktok.on("error", err => console.log("[@" + username + "] Erreur: " + err.message));
}

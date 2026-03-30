require('dotenv').config();

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");

const PORT         = process.env.PORT         || 3001;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";
const REDIS_URL    = process.env.UPSTASH_REDIS_REST_URL   || "https://lenient-leopard-36946.upstash.io";
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN || "AZBSAAIncDE3MjZjOThhMTI2ZDY0NjE4YTVjMTI5NjQ1OWYwZjdjMHAxMzY5NDY";

// ── Redis ─────────────────────────────────────────────────────
async function redisGet(key) {
  try {
    const r = await fetch(REDIS_URL + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify([["GET", key]])
    });
    const j = await r.json();
    const result = j[0] && j[0].result;
    if (!result) return null;
    let data = result;
    if (typeof data === "string") data = JSON.parse(data);
    if (data && typeof data.value === "string") data = JSON.parse(data.value);
    return data;
  } catch(e) { console.log("Redis GET error: " + e.message); return null; }
}

async function redisSet(key, value) {
  try {
    const r = await fetch(REDIS_URL + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value)]])
    });
    const j = await r.json();
    console.log("Redis SET " + key + " => " + (j[0] && j[0].result));
  } catch(e) { console.log("Redis SET error: " + e.message); }
}

async function redisDel(key) {
  try {
    await fetch(REDIS_URL + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify([["DEL", key]])
    });
  } catch(e) { console.log("Redis DEL error: " + e.message); }
}

// ── Serveur HTTP — sert les fichiers HTML + WebSocket ─────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = req.url.split("?")[0];

  if (url === "/" || url === "/index.html") {
    serveFile(res, path.join(__dirname, "index.html"), "text/html");
  } else if (url === "/admin" || url === "/admin.html") {
    serveFile(res, path.join(__dirname, "admin.html"), "text/html");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("TikTok Multi-Panel OK");
  }
});

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end("File not found");
    } else {
      res.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
      res.end(data);
    }
  });
}

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur actif port " + PORT);
  console.log("Panel: http://188.40.251.75:" + PORT);
  console.log("Admin: http://188.40.251.75:" + PORT + "/admin");
});

// ── Rooms ─────────────────────────────────────────────────────
const rooms = {};

function roomKey(username, period) {
  return (period || "month") + ":" + username;
}

async function getRoom(key, username) {
  if (rooms[key]) {
    // Room existe mais TikTok peut ne pas être connecté
    if (!rooms[key].tiktok) connectTikTok(username);
    return rooms[key];
  }
  rooms[key] = { donations: {}, avatars: {}, opacity: 0.45, tiktok: null };
  try {
    const saved = await redisGet("room:" + key);
    if (saved && saved.donations) {
      rooms[key].donations = saved.donations;
      rooms[key].avatars   = saved.avatars || {};
      if (saved.opacity !== undefined) rooms[key].opacity = saved.opacity;
      console.log("Redis chargé [" + key + "] — " + Object.keys(saved.donations).length + " joueurs");
    }
  } catch(e) { console.log("Erreur Redis [" + key + "]: " + e.message); }
  connectTikTok(username);
  return rooms[key];
}

async function saveRoom(key) {
  const r = rooms[key];
  if (!r) return;
  await redisSet("room:" + key, { donations: r.donations, avatars: r.avatars, opacity: r.opacity });
}

function getTop3(key) {
  const r = rooms[key];
  if (!r) return [];
  return Object.entries(r.donations)
    .map(([name, coins]) => ({ name, coins, avatar: r.avatars[name] || null }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3);
}

function broadcastKey(key, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.roomKey === key) c.send(msg);
  });
}

async function resetRoom(key) {
  const r = rooms[key];
  if (r) { r.donations = {}; r.avatars = {}; }
  await redisDel("room:" + key);
  broadcastKey(key, { type: "reset" });
  console.log("Reset [" + key + "]");
}

wss.on("connection", socket => {
  socket.roomKey = null;
  socket.on("message", async raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "join" && msg.username) {
        const period = msg.period || "month";
        const key = roomKey(msg.username, period);
        socket.roomKey = key;
        await getRoom(key, msg.username);
        setTimeout(function() {
          if (socket.readyState === WebSocket.OPEN) {
            const r = rooms[key];
            socket.send(JSON.stringify({ type: "sync", top3: getTop3(key) }));
            if (r && r.opacity !== undefined) socket.send(JSON.stringify({ type: "opacity", value: r.opacity }));
          }
        }, 300);
        console.log("Panel rejoint: @" + msg.username + " [" + period + "]");
      }
      if (msg.type === "reset" && msg.secret === ADMIN_SECRET && msg.username) {
        const key = roomKey(msg.username, msg.period || "month");
        await resetRoom(key);
      }
      if (msg.type === "opacity" && msg.secret === ADMIN_SECRET && msg.username) {
        const key = roomKey(msg.username, msg.period || "month");
        if (!rooms[key]) rooms[key] = { donations: {}, avatars: {}, opacity: msg.value, tiktok: null };
        rooms[key].opacity = msg.value;
        await saveRoom(key);
        broadcastKey(key, { type: "opacity", value: msg.value });
      }
    } catch(e) {}
  });
  socket.on("error", () => {});
});

// ── TikTok ────────────────────────────────────────────────────
function connectTikTok(username) {
  for (var k of Object.keys(rooms)) {
    if (k.split(":")[1] === username && rooms[k].tiktok && rooms[k].tiktok._isConnecting) {
      console.log("TikTok deja en connexion pour @" + username);
      return;
    }
  }

  const tiktok = new WebcastPushConnection(username, {
    processInitialData    : false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    sessionId: process.env.TIKTOK_SESSION_ID || "",
    requestHeaders: {
      Cookie: "sessionid=" + (process.env.TIKTOK_SESSION_ID || "") + "; tt_chain_token=" + (process.env.TIKTOK_TT_CHAIN || "") + "; msToken=" + (process.env.TIKTOK_MS_TOKEN || "")
    }
  });

  tiktok._isConnecting = true;

  for (var key2 of Object.keys(rooms)) {
    if (key2.split(":")[1] === username) rooms[key2].tiktok = tiktok;
  }

  tiktok.connect()
    .then(() => {
      tiktok._isConnecting = false;
      console.log("Connecte @" + username);
      Object.keys(rooms).forEach(function(k) {
        if (k.split(":")[1] === username) broadcastKey(k, { type: "status", online: true });
      });
    })
    .catch(err => {
      tiktok._isConnecting = false;
      console.log("Erreur @" + username + ": " + err.message + " — retry 30s");
      for (var key3 of Object.keys(rooms)) {
        if (key3.split(":")[1] === username) rooms[key3].tiktok = null;
      }
      setTimeout(() => connectTikTok(username), 30000);
    });

  tiktok.on("gift", async data => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const pseudo = data.uniqueId || "anonyme";
    const coins  = (data.diamondCount || 1) * (data.repeatCount || 1);
    for (var key of Object.keys(rooms)) {
      if (key.split(":")[1] !== username) continue;
      const r = rooms[key];
      r.donations[pseudo] = (r.donations[pseudo] || 0) + coins;
      if (data.profilePictureUrl && !r.avatars[pseudo]) r.avatars[pseudo] = data.profilePictureUrl;
      await saveRoom(key);
      broadcastKey(key, {
        type : "gift",
        donor: { name: pseudo, coins: r.donations[pseudo], avatar: r.avatars[pseudo] || null },
        top3 : getTop3(key),
      });
    }
    console.log("[@" + username + "] " + pseudo + " +" + coins);
  });

  tiktok.on("disconnected", () => {
    console.log("Deconnecte @" + username + " retry 15s");
    for (var key4 of Object.keys(rooms)) {
      if (key4.split(":")[1] === username) rooms[key4].tiktok = null;
    }
    setTimeout(() => connectTikTok(username), 15000);
  });

  tiktok.on("error", err => { console.log("[@" + username + "] " + err.message); });
}


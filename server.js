const http = require("http");
const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");

const PORT         = process.env.PORT         || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || "https://cool-warthog-80931.upstash.io";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAATwjAAIncDJhN2NhYTA4NjE4MGI0MGY1YTJlN2Q5ZDkxMWE5NzVhYnAyODA5MzE";

// ── Redis helpers (Upstash REST API) ─────────────────────────
async function redisCmd(args) {
  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    });
    const j = await r.json();
    return j.result !== undefined ? j.result : null;
  } catch(e) { console.log("Redis error:", e.message); return null; }
}

async function redisGet(key) {
  try {
    const result = await redisCmd(["GET", key]);
    return result ? JSON.parse(result) : null;
  } catch(e) { console.log("Redis GET error:", e.message); return null; }
}

async function redisSet(key, value) {
  try {
    await redisCmd(["SET", key, JSON.stringify(value)]);
  } catch(e) { console.log("Redis SET error:", e.message); }
}

async function redisDel(key) {
  try {
    await redisCmd(["DEL", key]);
  } catch(e) { console.log("Redis DEL error:", e.message); }
}

// ── Serveur HTTP + WebSocket ──────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("TikTok Multi-Panel OK");
});

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur actif port " + PORT);
});

// ── Rooms en mémoire ──────────────────────────────────────────
const rooms = {};

async function getRoom(username) {
  if (rooms[username]) return rooms[username];

  rooms[username] = { donations: {}, avatars: {}, tiktok: null };

  try {
    const saved = await redisGet("room:" + username);
    if (saved && saved.donations) {
      rooms[username].donations = saved.donations;
      rooms[username].avatars   = saved.avatars || {};
      console.log("Redis chargé pour @" + username + " — " + Object.keys(saved.donations).length + " joueurs");
    }
  } catch(e) {
    console.log("Erreur Redis pour @" + username + ": " + e.message);
  }

  connectTikTok(username);
  return rooms[username];
}

async function saveRoom(username) {
  const r = rooms[username];
  if (!r) return;
  await redisSet("room:" + username, {
    donations: r.donations,
    avatars:   r.avatars
  });
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

async function resetRoom(username) {
  const r = rooms[username];
  if (r) {
    r.donations = {};
    r.avatars   = {};
  }
  await redisDel("room:" + username);
  broadcastRoom(username, { type: "reset" });
  console.log("Reset @" + username);
}

// ── WebSocket ─────────────────────────────────────────────────
wss.on("connection", socket => {
  socket.room = null;

  socket.on("message", async raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "join" && msg.username) {
        socket.room = msg.username;
        getRoom(msg.username).then(function() {
          setTimeout(function() {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: "sync",
                top3: getTop3(msg.username)
              }));
            }
          }, 500);
        });
        console.log("Panel rejoint: @" + msg.username);
      }

      if (msg.type === "reset" && msg.secret === ADMIN_SECRET && msg.username) {
        await resetRoom(msg.username);
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
    processInitialData    : false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    clientParams: {
      app_language: "fr-FR",
      device_platform: "web",
    },
    sessionId: "",
    enableCookies: false,
    requestOptions: {
      params: {
        uniqueId: username,
      }
    }
  });

  r.tiktok = tiktok;

  tiktok.connect()
    .then(() => {
      console.log("Connecte @" + username);
      broadcastRoom(username, { type: "status", online: true });
    })
    .catch(err => {
      console.log("Erreur @" + username + ": " + err.message + " — retry 30s");
      setTimeout(() => connectTikTok(username), 30000);
    });

  tiktok.on("gift", async data => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const pseudo = data.uniqueId || "anonyme";
    const coins  = (data.diamondCount || 1) * (data.repeatCount || 1);
    r.donations[pseudo] = (r.donations[pseudo] || 0) + coins;
    if (data.profilePictureUrl && !r.avatars[pseudo]) {
      r.avatars[pseudo] = data.profilePictureUrl;
    }
    console.log("[@" + username + "] " + pseudo + " +" + coins + " (total: " + r.donations[pseudo] + ")");

    // Sauvegarder dans Redis
    await saveRoom(username);

    broadcastRoom(username, {
      type : "gift",
      donor: { name: pseudo, coins: r.donations[pseudo], avatar: r.avatars[pseudo] || null },
      top3 : getTop3(username),
    });
  });

  tiktok.on("disconnected", () => {
    console.log("Deconnecte @" + username + " — retry 15s");
    setTimeout(() => connectTikTok(username), 15000);
  });

  tiktok.on("error", err => {
    console.log("[@" + username + "] " + err.message);
  });
}

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const WORLD_WIDTH = 3200;
const WORLD_HEIGHT = 3200;
const PLAYER_SPEED = 260;
const TICK_RATE = 30;
const ROCK_RESPAWN_MS = 9000;
const MINE_RANGE = 90;
const MINE_COOLDOWN_MS = 220;
const INVENTORY_FILE = path.join(__dirname, "inventories.json");
const TOKEN_RE = /^[a-zA-Z0-9_-]{8,80}$/;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const players = new Map();
const messages = [];
const MAX_MESSAGES = 80;
const inventories = loadInventories();
const rocks = createRocks();
let inventoryWriteTimer = null;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomColor() {
  const hue = randomInt(0, 359);
  return `hsl(${hue} 75% 55%)`;
}

function generateToken() {
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2, 8)}`;
}

function validToken(token) {
  return typeof token === "string" && TOKEN_RE.test(token);
}

function loadInventories() {
  try {
    if (!fs.existsSync(INVENTORY_FILE)) return {};
    const raw = fs.readFileSync(INVENTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function queueInventorySave() {
  if (inventoryWriteTimer) return;
  inventoryWriteTimer = setTimeout(() => {
    inventoryWriteTimer = null;
    fs.writeFile(
      INVENTORY_FILE,
      JSON.stringify(inventories, null, 2),
      "utf8",
      () => {}
    );
  }, 250);
}

function flushInventoriesSync() {
  try {
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inventories, null, 2), "utf8");
  } catch {
    // Ignore write failures; gameplay continues even if persistence fails.
  }
}

function ensureInventory(token) {
  if (!inventories[token]) {
    inventories[token] = {
      rocks: 0,
      updatedAt: nowIso()
    };
  } else if (typeof inventories[token].rocks !== "number" || !Number.isFinite(inventories[token].rocks)) {
    inventories[token].rocks = 0;
    inventories[token].updatedAt = nowIso();
  }
  return inventories[token];
}

function sanitizeName(rawName) {
  const fallback = `Player-${randomInt(1000, 9999)}`;
  if (typeof rawName !== "string") return fallback;
  const cleaned = rawName.replace(/[^\w\- ]/g, "").trim().slice(0, 18);
  return cleaned.length ? cleaned : fallback;
}

function sanitizeChat(rawText) {
  if (typeof rawText !== "string") return "";
  return rawText.replace(/\s+/g, " ").trim().slice(0, 160);
}

function nowIso() {
  return new Date().toISOString();
}

function broadcast(packet) {
  const serialized = JSON.stringify(packet);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  });
}

function parseTokenFromRequest(request) {
  try {
    const base = `http://${request.headers.host || "localhost"}`;
    const parsedUrl = new URL(request.url || "/", base);
    const token = parsedUrl.searchParams.get("token");
    return validToken(token) ? token : null;
  } catch {
    return null;
  }
}

function clampPosition(player) {
  if (player.x < 0) player.x = 0;
  if (player.y < 0) player.y = 0;
  if (player.x > WORLD_WIDTH) player.x = WORLD_WIDTH;
  if (player.y > WORLD_HEIGHT) player.y = WORLD_HEIGHT;
}

function currentPlayerState() {
  return Array.from(players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    x: player.x,
    y: player.y,
    moving: player.input.up || player.input.down || player.input.left || player.input.right
  }));
}

function createRocks() {
  return [
    {
      id: "infinite-rock",
      x: WORLD_WIDTH - 100,
      y: WORLD_HEIGHT - 100,
      radius: 44,
      availableAt: 0,
      infinite: true
    }
  ];
}

function currentRockState() {
  return rocks.map((rock) => ({
    id: rock.id,
    x: rock.x,
    y: rock.y,
    radius: rock.radius,
    availableAt: rock.availableAt,
    infinite: !!rock.infinite
  }));
}

function nearestMineableRock(player, now) {
  const maxDistSquared = MINE_RANGE * MINE_RANGE;
  let winner = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const rock of rocks) {
    if (rock.availableAt > now) continue;
    const dx = rock.x - player.x;
    const dy = rock.y - player.y;
    const distSquared = dx * dx + dy * dy;
    if (distSquared > maxDistSquared) continue;
    if (distSquared < bestDist) {
      bestDist = distSquared;
      winner = rock;
    }
  }

  return winner;
}

function sendInventory(socket, player) {
  socket.send(
    JSON.stringify({
      type: "inventory",
      inventory: {
        rocks: player.inventoryRocks
      }
    })
  );
}

wss.on("connection", (socket, request) => {
  const id = Math.random().toString(36).slice(2, 10);
  const token = parseTokenFromRequest(request) || generateToken();
  const inv = ensureInventory(token);
  const player = {
    id,
    token,
    name: `Player-${randomInt(1000, 9999)}`,
    color: randomColor(),
    x: randomInt(100, WORLD_WIDTH - 100),
    y: randomInt(100, WORLD_HEIGHT - 100),
    inventoryRocks: Math.max(0, Math.floor(inv.rocks || 0)),
    lastMineAt: 0,
    input: {
      up: false,
      down: false,
      left: false,
      right: false
    }
  };

  players.set(id, player);

  socket.send(
    JSON.stringify({
      type: "welcome",
      id,
      token,
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, tickRate: TICK_RATE },
      players: currentPlayerState(),
      messages,
      rocks: currentRockState(),
      inventory: {
        rocks: player.inventoryRocks
      }
    })
  );

  broadcast({
    type: "player-join",
    player: {
      id: player.id,
      name: player.name,
      color: player.color,
      x: player.x,
      y: player.y,
      moving: false
    }
  });

  socket.on("message", (rawData) => {
    let packet;
    try {
      packet = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    const active = players.get(id);
    if (!active || !packet || typeof packet.type !== "string") return;

    if (packet.type === "join") {
      const renamed = sanitizeName(packet.name);
      active.name = renamed;
      if (validToken(packet.token)) {
        active.token = packet.token;
        const loaded = ensureInventory(active.token);
        active.inventoryRocks = Math.max(0, Math.floor(loaded.rocks || 0));
        sendInventory(socket, active);
      }
      broadcast({
        type: "player-rename",
        id,
        name: renamed
      });
      return;
    }

    if (packet.type === "input" && packet.input && typeof packet.input === "object") {
      active.input.up = !!packet.input.up;
      active.input.down = !!packet.input.down;
      active.input.left = !!packet.input.left;
      active.input.right = !!packet.input.right;
      return;
    }

    if (packet.type === "chat") {
      const text = sanitizeChat(packet.text);
      if (!text) return;
      const entry = {
        id: Math.random().toString(36).slice(2, 11),
        playerId: id,
        name: active.name,
        text,
        at: nowIso()
      };
      messages.push(entry);
      if (messages.length > MAX_MESSAGES) {
        messages.splice(0, messages.length - MAX_MESSAGES);
      }
      broadcast({
        type: "chat",
        message: entry
      });
      return;
    }

    if (packet.type === "mine") {
      const now = Date.now();
      if (now - active.lastMineAt < MINE_COOLDOWN_MS) return;
      active.lastMineAt = now;

      const rock = nearestMineableRock(active, now);
      if (!rock) return;

      if (!rock.infinite) {
        rock.availableAt = now + ROCK_RESPAWN_MS;
      }
      active.inventoryRocks += 1;

      const invEntry = ensureInventory(active.token);
      invEntry.rocks = active.inventoryRocks;
      invEntry.updatedAt = nowIso();
      queueInventorySave();

      socket.send(
        JSON.stringify({
          type: "mine-result",
          ok: true,
          gained: {
            rocks: 1
          },
          inventory: {
            rocks: active.inventoryRocks
          }
        })
      );

      if (!rock.infinite) {
        broadcast({
          type: "rock-update",
          rock: {
            id: rock.id,
            availableAt: rock.availableAt
          }
        });
      }
    }
  });

  socket.on("close", () => {
    const closing = players.get(id);
    if (closing) {
      const invEntry = ensureInventory(closing.token);
      invEntry.rocks = closing.inventoryRocks;
      invEntry.updatedAt = nowIso();
      queueInventorySave();
    }
    players.delete(id);
    broadcast({
      type: "player-leave",
      id
    });
  });
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const delta = (now - lastTick) / 1000;
  lastTick = now;

  players.forEach((player) => {
    const vertical = Number(player.input.down) - Number(player.input.up);
    const horizontal = Number(player.input.right) - Number(player.input.left);

    let vx = horizontal;
    let vy = vertical;
    if (vx !== 0 || vy !== 0) {
      const length = Math.hypot(vx, vy);
      vx /= length;
      vy /= length;
      player.x += vx * PLAYER_SPEED * delta;
      player.y += vy * PLAYER_SPEED * delta;
      clampPosition(player);
    }
  });

  broadcast({
    type: "state",
    players: currentPlayerState(),
    serverTime: now
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`MMO server running: http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  flushInventoriesSync();
  process.exit(0);
});

process.on("SIGTERM", () => {
  flushInventoriesSync();
  process.exit(0);
});

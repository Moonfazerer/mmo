const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const playerCountEl = document.getElementById("playerCount");
const inventoryCountEl = document.getElementById("inventoryCount");
const mineHelpEl = document.getElementById("mineHelp");
const miniMapCanvas = document.getElementById("miniMap");
const miniMapCtx = miniMapCanvas.getContext("2d");
const chatLogEl = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const joinDialog = document.getElementById("joinDialog");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");

const STORAGE_TOKEN_KEY = "mmo_player_token_v1";
const STORAGE_NAME_KEY = "mmo_player_name_v1";
const MINE_RANGE = 90;

const players = new Map();
const rocks = new Map();
const state = {
  myId: null,
  myToken: getOrCreatePlayerToken(),
  connected: false,
  worldWidth: 3200,
  worldHeight: 3200,
  inventoryRocks: 0,
  keys: {
    up: false,
    down: false,
    left: false,
    right: false
  }
};

let socket;
let reconnectTimer = null;

function randomToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2, 8)}`;
}

function getStorageSafe(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStorageSafe(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures (private mode, blocked storage).
  }
}

function getOrCreatePlayerToken() {
  const existing = getStorageSafe(STORAGE_TOKEN_KEY);
  if (existing) return existing;
  const created = randomToken();
  setStorageSafe(STORAGE_TOKEN_KEY, created);
  return created;
}

function resolveSocketUrl() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("ws");
  let baseUrl;

  if (fromQuery) {
    baseUrl = fromQuery;
  } else if (location.protocol === "file:") {
    baseUrl = "ws://localhost:3000";
  } else {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    baseUrl = `${protocol}://${location.host}`;
  }

  try {
    const url = new URL(baseUrl, location.href);
    url.searchParams.set("token", state.myToken);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function resizeCanvas() {
  canvas.width = Math.floor(window.innerWidth * window.devicePixelRatio);
  canvas.height = Math.floor(window.innerHeight * window.devicePixelRatio);
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);

  const mapDpr = window.devicePixelRatio || 1;
  miniMapCanvas.width = Math.floor(miniMapCanvas.clientWidth * mapDpr);
  miniMapCanvas.height = Math.floor(miniMapCanvas.clientHeight * mapDpr);
  miniMapCtx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0);
}

function addChatLine(entry) {
  const line = document.createElement("div");
  line.className = "line";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = `${entry.name}: `;
  const text = document.createElement("span");
  text.textContent = entry.text;
  line.appendChild(name);
  line.appendChild(text);
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;

  while (chatLogEl.children.length > 80) {
    chatLogEl.firstChild.remove();
  }
}

function sendPacket(packet) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(packet));
}

function setInventoryCount(rocksCount) {
  const normalized = Math.max(0, Number.isFinite(rocksCount) ? Math.floor(rocksCount) : 0);
  state.inventoryRocks = normalized;
  inventoryCountEl.textContent = `Rocks: ${state.inventoryRocks}`;
}

function applyRockSnapshot(snapshot) {
  rocks.clear();
  for (const rock of snapshot || []) {
    rocks.set(rock.id, rock);
  }
}

function setupConnection() {
  const socketUrl = resolveSocketUrl();
  statusEl.textContent = "Connecting...";

  try {
    socket = new WebSocket(socketUrl);
  } catch {
    statusEl.textContent = `Connection failed (${socketUrl})`;
    return;
  }

  socket.addEventListener("open", () => {
    state.connected = true;
    statusEl.textContent = "Connected";
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    statusEl.textContent = "Disconnected, retrying...";
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        setupConnection();
      }, 1500);
    }
  });

  socket.addEventListener("error", () => {
    statusEl.textContent = `WebSocket error (${socketUrl})`;
  });

  socket.addEventListener("message", (event) => {
    let packet;
    try {
      packet = JSON.parse(event.data);
    } catch {
      return;
    }

    if (packet.type === "welcome") {
      state.myId = packet.id;
      if (packet.token && typeof packet.token === "string") {
        state.myToken = packet.token;
        setStorageSafe(STORAGE_TOKEN_KEY, packet.token);
      }
      state.worldWidth = packet.world.width;
      state.worldHeight = packet.world.height;
      players.clear();
      for (const p of packet.players || []) {
        players.set(p.id, p);
      }
      applyRockSnapshot(packet.rocks || []);
      setInventoryCount(packet.inventory ? packet.inventory.rocks : 0);
      playerCountEl.textContent = `Players: ${players.size}`;
      chatLogEl.textContent = "";
      for (const message of packet.messages || []) {
        addChatLine(message);
      }
      const savedName = getStorageSafe(STORAGE_NAME_KEY);
      if (savedName) {
        sendPacket({ type: "join", name: savedName, token: state.myToken });
        if (joinDialog.open) joinDialog.close();
      } else if (!joinDialog.open) {
        joinDialog.showModal();
      }
      return;
    }

    if (packet.type === "state") {
      for (const p of packet.players || []) {
        players.set(p.id, p);
      }
      playerCountEl.textContent = `Players: ${players.size}`;
      return;
    }

    if (packet.type === "player-join" && packet.player) {
      players.set(packet.player.id, packet.player);
      playerCountEl.textContent = `Players: ${players.size}`;
      return;
    }

    if (packet.type === "player-leave" && packet.id) {
      players.delete(packet.id);
      playerCountEl.textContent = `Players: ${players.size}`;
      return;
    }

    if (packet.type === "player-rename") {
      const p = players.get(packet.id);
      if (p) p.name = packet.name;
      return;
    }

    if (packet.type === "chat" && packet.message) {
      addChatLine(packet.message);
      return;
    }

    if (packet.type === "rock-update" && packet.rock && packet.rock.id) {
      const existing = rocks.get(packet.rock.id);
      if (existing) {
        existing.availableAt = packet.rock.availableAt;
      } else {
        rocks.set(packet.rock.id, packet.rock);
      }
      return;
    }

    if (packet.type === "mine-result" && packet.ok && packet.inventory) {
      setInventoryCount(packet.inventory.rocks);
      return;
    }

    if (packet.type === "inventory" && packet.inventory) {
      setInventoryCount(packet.inventory.rocks);
    }
  });
}

function trackKeyState(event, isDown) {
  if (joinDialog.open) return;

  const wasd = {
    KeyW: "up",
    ArrowUp: "up",
    KeyS: "down",
    ArrowDown: "down",
    KeyA: "left",
    ArrowLeft: "left",
    KeyD: "right",
    ArrowRight: "right"
  };

  const key = wasd[event.code];
  if (!key) return;
  if (state.keys[key] === isDown) return;
  state.keys[key] = isDown;
  sendPacket({ type: "input", input: state.keys });
  event.preventDefault();
}

function drawGrid(cameraX, cameraY) {
  const step = 80;
  const viewWidth = canvas.width / window.devicePixelRatio;
  const viewHeight = canvas.height / window.devicePixelRatio;

  ctx.strokeStyle = "rgb(255 255 255 / 6%)";
  ctx.lineWidth = 1;

  const startX = Math.floor(cameraX / step) * step;
  const endX = cameraX + viewWidth;
  for (let x = startX; x <= endX; x += step) {
    const sx = Math.floor(x - cameraX) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, viewHeight);
    ctx.stroke();
  }

  const startY = Math.floor(cameraY / step) * step;
  const endY = cameraY + viewHeight;
  for (let y = startY; y <= endY; y += step) {
    const sy = Math.floor(y - cameraY) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(viewWidth, sy);
    ctx.stroke();
  }
}

function drawWorldBounds(cameraX, cameraY) {
  const x = -cameraX;
  const y = -cameraY;
  ctx.strokeStyle = "rgb(255 255 255 / 18%)";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, state.worldWidth, state.worldHeight);
}

function drawRock(rock, cameraX, cameraY) {
  const x = rock.x - cameraX;
  const y = rock.y - cameraY;
  const available = Date.now() >= rock.availableAt;
  const radius = rock.radius || 24;
  const isInfinite = !!rock.infinite;

  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius * 0.8, y - radius * 0.2);
  ctx.lineTo(x + radius * 0.65, y + radius * 0.7);
  ctx.lineTo(x - radius * 0.5, y + radius * 0.85);
  ctx.lineTo(x - radius * 0.85, y + radius * 0.05);
  ctx.closePath();
  ctx.fillStyle = isInfinite ? "#f5b74f" : available ? "#95a9bf" : "#3a4656";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = isInfinite ? "#ffe1a5" : available ? "#d6e4f3" : "#566579";
  ctx.stroke();

  if (isInfinite) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#fff4d0";
    ctx.fill();
  }
}

function drawRocks(cameraX, cameraY) {
  for (const rock of rocks.values()) {
    drawRock(rock, cameraX, cameraY);
  }
}

function getInfiniteRock() {
  for (const rock of rocks.values()) {
    if (rock.infinite) return rock;
  }
  return null;
}

function drawPlayers(cameraX, cameraY) {
  const me = players.get(state.myId);
  const meX = me ? me.x : state.worldWidth / 2;
  const meY = me ? me.y : state.worldHeight / 2;

  const sorted = Array.from(players.values()).sort((a, b) => {
    const ad = (a.x - meX) ** 2 + (a.y - meY) ** 2;
    const bd = (b.x - meX) ** 2 + (b.y - meY) ** 2;
    return ad - bd;
  });

  for (const p of sorted) {
    const x = p.x - cameraX;
    const y = p.y - cameraY;

    ctx.beginPath();
    ctx.arc(x, y, p.id === state.myId ? 18 : 14, 0, Math.PI * 2);
    ctx.fillStyle = p.color || "#5fa3ff";
    ctx.fill();

    if (p.id === state.myId) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }

    ctx.font = "13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#f8fbff";
    ctx.fillText(p.name || p.id, x, y - 24);
  }
}

function getNearestMineableRock() {
  const me = players.get(state.myId);
  if (!me) return null;

  const maxDistSquared = MINE_RANGE * MINE_RANGE;
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const rock of rocks.values()) {
    if (Date.now() < rock.availableAt) continue;
    const dx = rock.x - me.x;
    const dy = rock.y - me.y;
    const distSquared = dx * dx + dy * dy;
    if (distSquared > maxDistSquared) continue;
    if (distSquared < bestDist) {
      bestDist = distSquared;
      best = rock;
    }
  }
  return best;
}

function getCamera() {
  const me = players.get(state.myId);
  const viewWidth = canvas.width / window.devicePixelRatio;
  const viewHeight = canvas.height / window.devicePixelRatio;

  if (!me) {
    return { x: 0, y: 0 };
  }

  let cameraX = me.x - viewWidth / 2;
  let cameraY = me.y - viewHeight / 2;

  cameraX = Math.max(0, Math.min(state.worldWidth - viewWidth, cameraX));
  cameraY = Math.max(0, Math.min(state.worldHeight - viewHeight, cameraY));
  return { x: cameraX, y: cameraY };
}

function drawMiniMap(cameraX, cameraY, viewWidth, viewHeight) {
  const width = miniMapCanvas.clientWidth;
  const height = miniMapCanvas.clientHeight;
  if (!width || !height) return;

  const padding = 6;
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const scale = Math.min(innerW / state.worldWidth, innerH / state.worldHeight);
  const worldDrawW = state.worldWidth * scale;
  const worldDrawH = state.worldHeight * scale;
  const offsetX = (width - worldDrawW) / 2;
  const offsetY = (height - worldDrawH) / 2;

  miniMapCtx.clearRect(0, 0, width, height);

  miniMapCtx.fillStyle = "#0b1624";
  miniMapCtx.fillRect(0, 0, width, height);

  miniMapCtx.strokeStyle = "rgb(255 255 255 / 20%)";
  miniMapCtx.lineWidth = 1;
  miniMapCtx.strokeRect(offsetX + 0.5, offsetY + 0.5, worldDrawW, worldDrawH);

  for (const rock of rocks.values()) {
    if (Date.now() < rock.availableAt) continue;
    const x = offsetX + rock.x * scale;
    const y = offsetY + rock.y * scale;
    if (rock.infinite) {
      miniMapCtx.beginPath();
      miniMapCtx.arc(x, y, 3, 0, Math.PI * 2);
      miniMapCtx.fillStyle = "#ffd070";
      miniMapCtx.fill();
    } else {
      miniMapCtx.fillStyle = "#8ea3ba";
      miniMapCtx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  for (const player of players.values()) {
    const x = offsetX + player.x * scale;
    const y = offsetY + player.y * scale;
    miniMapCtx.beginPath();
    miniMapCtx.arc(x, y, player.id === state.myId ? 3 : 2, 0, Math.PI * 2);
    miniMapCtx.fillStyle = player.id === state.myId ? "#ffffff" : player.color || "#5fa3ff";
    miniMapCtx.fill();
  }

  const viewX = offsetX + cameraX * scale;
  const viewY = offsetY + cameraY * scale;
  const viewW = viewWidth * scale;
  const viewH = viewHeight * scale;
  miniMapCtx.strokeStyle = "rgb(75 137 255 / 90%)";
  miniMapCtx.lineWidth = 1.5;
  miniMapCtx.strokeRect(viewX, viewY, viewW, viewH);
}

function drawInfiniteRockBeacon(cameraX, cameraY, viewWidth, viewHeight) {
  const rock = getInfiniteRock();
  if (!rock) return;

  const sx = rock.x - cameraX;
  const sy = rock.y - cameraY;
  const pad = 24;
  const onScreen = sx >= pad && sx <= viewWidth - pad && sy >= pad && sy <= viewHeight - pad;
  if (onScreen) return;

  const cx = Math.max(pad, Math.min(viewWidth - pad, sx));
  const cy = Math.max(pad, Math.min(viewHeight - pad, sy));
  const angle = Math.atan2(sy - cy, sx - cx);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(13, 0);
  ctx.lineTo(-9, 7);
  ctx.lineTo(-9, -7);
  ctx.closePath();
  ctx.fillStyle = "#ffd070";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffe8b8";
  ctx.stroke();
  ctx.restore();

  ctx.font = "12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffe8b8";
  ctx.fillText("Infinite Rock", cx, cy - 12);
}

function render() {
  const viewWidth = canvas.width / window.devicePixelRatio;
  const viewHeight = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, viewWidth, viewHeight);

  const camera = getCamera();
  drawGrid(camera.x, camera.y);
  drawWorldBounds(camera.x, camera.y);
  drawRocks(camera.x, camera.y);
  drawPlayers(camera.x, camera.y);
  drawInfiniteRockBeacon(camera.x, camera.y, viewWidth, viewHeight);
  drawMiniMap(camera.x, camera.y, viewWidth, viewHeight);

  const mineable = getNearestMineableRock();
  mineHelpEl.textContent = mineable ? "Press E to mine this rock" : "Mine the gold rock at bottom-right (E)";

  requestAnimationFrame(render);
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendPacket({
    type: "chat",
    text
  });
  chatInput.value = "";
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim() || `Player-${Math.floor(Math.random() * 9000 + 1000)}`;
  setStorageSafe(STORAGE_NAME_KEY, name);
  sendPacket({ type: "join", name, token: state.myToken });
  joinDialog.close();
  canvas.focus();
});

window.addEventListener("keydown", (event) => {
  if (document.activeElement === chatInput) return;
  if (event.code === "KeyE") {
    if (joinDialog.open || event.repeat) return;
    sendPacket({ type: "mine" });
    event.preventDefault();
    return;
  }
  trackKeyState(event, true);
});

window.addEventListener("keyup", (event) => {
  trackKeyState(event, false);
});

window.addEventListener("resize", resizeCanvas);

nameInput.value = getStorageSafe(STORAGE_NAME_KEY) || "";
setInventoryCount(0);
resizeCanvas();
setupConnection();
render();

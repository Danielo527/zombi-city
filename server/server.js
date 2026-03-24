const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocket.Server({ server: httpServer });

// { id, ws, name, skin, x, y, z, rot, health, weapon, room, kills }
const clients = new Map();
let nextId = 1;

// Зомбі на сервері: { zid, room, type, x, z, health, target_id }
const zombies = new Map();
let nextZid = 1;

function broadcast(room, data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, c] of clients) {
    if (c.room === room && id !== excludeId && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

function broadcastAll(room, data) {
  broadcast(room, data, null);
}

function roomPlayers(room) {
  const list = [];
  for (const [id, c] of clients) {
    if (c.room === room) {
      list.push({ id, name: c.name, skin: c.skin, x: c.x, y: c.y, z: c.z, rot: c.rot, health: c.health, weapon: c.weapon, kills: c.kills });
    }
  }
  return list;
}

function getRoomList() {
  const rooms = {};
  for (const [, c] of clients) {
    if (!c.room) continue;
    if (!rooms[c.room]) rooms[c.room] = { name: c.room, players: 0 };
    rooms[c.room].players++;
  }
  return Object.values(rooms);
}

function getLeaderboard(room) {
  return roomPlayers(room)
    .sort((a, b) => b.kills - a.kills)
    .map(p => ({ id: p.id, name: p.name, kills: p.kills }));
}

// Хост кімнати — перший гравець
function getRoomHost(room) {
  for (const [id, c] of clients) {
    if (c.room === room) return id;
  }
  return null;
}

wss.on("connection", (ws) => {
  const id = nextId++;
  clients.set(id, { id, ws, name: "Гравець" + id, skin: 0, x: 0, y: 0, z: 0, rot: 0, health: 100, weapon: 0, room: null, kills: 0 });
  console.log(`[+] id=${id}  всього: ${clients.size}`);
  ws.send(JSON.stringify({ type: "welcome", id }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const c = clients.get(id);
    if (!c) return;

    switch (msg.type) {

      case "get_rooms": {
        ws.send(JSON.stringify({ type: "room_list", rooms: getRoomList() }));
        break;
      }

      case "join": {
        c.room   = msg.room  || "default";
        c.name   = (msg.name || c.name).slice(0, 24);
        c.skin   = msg.skin  || 0;
        c.kills  = 0;
        // Повідомляємо всіх в кімнаті про нового гравця
        broadcast(c.room, { type: "player_joined", id, name: c.name, skin: c.skin }, id);
        // Відправляємо новому список існуючих + зомбі кімнати
        const existingPlayers = roomPlayers(c.room).filter(p => p.id !== id);
        const roomZombies = [];
        for (const [zid, z] of zombies) {
          if (z.room === c.room) roomZombies.push({ zid, ztype: z.type, x: z.x, z: z.z, health: z.health });
        }
        ws.send(JSON.stringify({ type: "room_state", players: existingPlayers, zombies: roomZombies }));
        // Оновлюємо список кімнат для всіх
        for (const [, cl] of clients) {
          if (cl.ws.readyState === WebSocket.OPEN)
            cl.ws.send(JSON.stringify({ type: "room_list", rooms: getRoomList() }));
        }
        console.log(`[join] id=${id} name=${c.name} skin=${c.skin} room=${c.room}`);
        break;
      }

      case "move": {
        c.x = msg.x; c.y = msg.y; c.z = msg.z; c.rot = msg.rot || 0;
        broadcast(c.room, { type: "move", id, x: c.x, y: c.y, z: c.z, rot: c.rot }, id);
        break;
      }

      case "health": {
        c.health = msg.health;
        broadcast(c.room, { type: "health", id, health: c.health }, id);
        break;
      }

      case "weapon": {
        c.weapon = msg.weapon;
        broadcast(c.room, { type: "weapon", id, weapon: c.weapon }, id);
        break;
      }

      // Зомбі спавниться (хост)
      case "zombie_spawn": {
        const zid = nextZid++;
        zombies.set(zid, { room: c.room, type: msg.ztype, x: msg.x, z: msg.z, health: msg.health || 100 });
        console.log(`[zombie_spawn] room=${c.room} zid=${zid} type=${msg.ztype}`);
        // Надсилаємо всім в кімнаті ВКЛЮЧНО з хостом щоб він знав реальний zid
        broadcastAll(c.room, { type: "zombie_spawn", zid, ztype: msg.ztype, x: msg.x, z: msg.z, health: msg.health || 100 });
        break;
      }

      // Позиція зомбі (хост)
      case "zombie_move": {
        const z = zombies.get(msg.zid);
        if (z) { z.x = msg.x; z.z = msg.z; }
        broadcast(c.room, { type: "zombie_move", zid: msg.zid, x: msg.x, z: msg.z }, id);
        break;
      }

      // Влучання по зомбі
      case "zombie_hit": {
        const z = zombies.get(msg.zid);
        if (z && z.room === c.room) {
          z.health -= msg.dmg;
          if (z.health <= 0) {
            zombies.delete(msg.zid);
            c.kills++;
            broadcastAll(c.room, { type: "zombie_died", zid: msg.zid, killer_id: id });
            // Оновлюємо лідерборд
            broadcastAll(c.room, { type: "leaderboard", board: getLeaderboard(c.room) });
          } else {
            broadcast(c.room, { type: "zombie_hit", zid: msg.zid, health: z.health }, id);
          }
        }
        break;
      }

      case "wave_start": {
        broadcastAll(c.room, { type: "wave_start", wave: msg.wave, total: msg.total });
        break;
      }

      case "chat": {
        const text = String(msg.text || "").slice(0, 120);
        broadcastAll(c.room, { type: "chat", id, name: c.name, text });
        break;
      }
    }
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (c && c.room) {
      broadcast(c.room, { type: "player_left", id });
      // Оновлюємо список кімнат
      clients.delete(id);
      for (const [, cl] of clients) {
        if (cl.ws.readyState === WebSocket.OPEN)
          cl.ws.send(JSON.stringify({ type: "room_list", rooms: getRoomList() }));
      }
    } else {
      clients.delete(id);
    }
    console.log(`[-] id=${id}  всього: ${clients.size}`);
  });
});

httpServer.listen(PORT);
console.log(`Сервер на порту ${PORT}`);

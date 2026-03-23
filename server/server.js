const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// { id, ws, name, x, y, z, health, weapon, room }
const clients = new Map();
let nextId = 1;

function broadcast(room, data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, c] of clients) {
    if (c.room === room && id !== excludeId && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

function roomList(room) {
  const list = [];
  for (const [id, c] of clients) {
    if (c.room === room) {
      list.push({ id, name: c.name, x: c.x, y: c.y, z: c.z, health: c.health, weapon: c.weapon });
    }
  }
  return list;
}

wss.on("connection", (ws) => {
  const id = nextId++;
  clients.set(id, { id, ws, name: "Гравець" + id, x: 0, y: 0, z: 0, health: 100, weapon: 0, room: null });
  console.log(`[+] Підключився id=${id}  всього: ${clients.size}`);

  ws.send(JSON.stringify({ type: "welcome", id }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const c = clients.get(id);
    if (!c) return;

    switch (msg.type) {

      // Приєднатись до кімнати
      case "join": {
        c.room  = msg.room  || "default";
        c.name  = msg.name  || c.name;
        c.x = c.y = c.z = 0;
        // Повідомляємо всіх в кімнаті
        broadcast(c.room, { type: "player_joined", id, name: c.name }, id);
        // Відправляємо новому гравцю список існуючих
        ws.send(JSON.stringify({ type: "room_state", players: roomList(c.room).filter(p => p.id !== id) }));
        console.log(`[join] id=${id} name=${c.name} room=${c.room}`);
        break;
      }

      // Позиція гравця
      case "move": {
        c.x = msg.x; c.y = msg.y; c.z = msg.z;
        c.rot = msg.rot || 0;
        broadcast(c.room, { type: "move", id, x: c.x, y: c.y, z: c.z, rot: c.rot }, id);
        break;
      }

      // Постріл / влучання
      case "hit": {
        broadcast(c.room, { type: "hit", shooter: id, target: msg.target, dmg: msg.dmg }, id);
        break;
      }

      // Смерть зомбі (хост повідомляє всіх)
      case "zombie_died": {
        broadcast(c.room, { type: "zombie_died", zid: msg.zid }, id);
        break;
      }

      // Спавн зомбі (хост спавнить, розсилає всім)
      case "zombie_spawn": {
        broadcast(c.room, { type: "zombie_spawn", zid: msg.zid, ztype: msg.ztype, x: msg.x, z: msg.z }, id);
        break;
      }

      // Позиція зомбі (хост оновлює)
      case "zombie_move": {
        broadcast(c.room, { type: "zombie_move", zid: msg.zid, x: msg.x, z: msg.z }, id);
        break;
      }

      // Нова хвиля
      case "wave_start": {
        broadcast(c.room, { type: "wave_start", wave: msg.wave, total: msg.total });
        break;
      }

      // Чат
      case "chat": {
        const text = String(msg.text || "").slice(0, 120);
        broadcast(c.room, { type: "chat", id, name: c.name, text });
        break;
      }

      // Зміна зброї
      case "weapon": {
        c.weapon = msg.weapon;
        broadcast(c.room, { type: "weapon", id, weapon: c.weapon }, id);
        break;
      }

      // Health update
      case "health": {
        c.health = msg.health;
        broadcast(c.room, { type: "health", id, health: c.health }, id);
        break;
      }
    }
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (c && c.room) {
      broadcast(c.room, { type: "player_left", id });
    }
    clients.delete(id);
    console.log(`[-] Відключився id=${id}  всього: ${clients.size}`);
  });
});

console.log(`Сервер запущено на порту ${PORT}`);

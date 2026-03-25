const WebSocket = require("ws");
const http = require("http");
const PORT = process.env.PORT || 8080;

const httpServer = http.createServer((req, res) => { res.writeHead(200); res.end("OK"); });
const wss = new WebSocket.Server({ server: httpServer });

const clients = new Map();
const zombies = new Map();
// room state: { wave, totalKills, bossKillThreshold, boss_zid, boss_hp, boss_max_hp, waveActive, hostId }
const roomState = new Map();
let nextId = 1, nextZid = 1;

function broadcast(room, data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, c] of clients)
    if (c.room === room && id !== excludeId && c.ws.readyState === WebSocket.OPEN)
      c.ws.send(msg);
}
function broadcastAll(room, data) { broadcast(room, data, null); }

function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

function roomPlayers(room) {
  const list = [];
  for (const [id, c] of clients)
    if (c.room === room)
      list.push({ id, name: c.name, skin: c.skin, x: c.x, y: c.y, z: c.z, rot: c.rot, health: c.health, kills: c.kills });
  return list;
}

function getRoomList() {
  const r = {};
  for (const [, c] of clients) {
    if (!c.room) continue;
    if (!r[c.room]) r[c.room] = { name: c.room, players: 0 };
    r[c.room].players++;
  }
  return Object.values(r);
}

function getLeaderboard(room) {
  return roomPlayers(room).sort((a,b) => b.kills - a.kills).map(p => ({ id: p.id, name: p.name, kills: p.kills }));
}

function getOrCreateRoom(name) {
  if (!roomState.has(name))
    roomState.set(name, { wave: 0, totalKills: 0, bossKillThreshold: 50, boss_zid: -1, boss_hp: 0, boss_max_hp: 0, waveActive: false, hostId: -1 });
  return roomState.get(name);
}

function getRoomHost(room) {
  for (const [id, c] of clients)
    if (c.room === room) return id;
  return -1;
}

// Сервер командує хосту спавнити нову хвилю
function startWave(room) {
  const rd = getOrCreateRoom(room);
  rd.wave++;
  rd.waveActive = true;
  const total = 50 + (rd.wave - 1) * 20;
  broadcastAll(room, { type: "wave_start", wave: rd.wave, total });
  // Командуємо хосту спавнити зомбі
  const hostId = getRoomHost(room);
  const hostClient = clients.get(hostId);
  if (hostClient) send(hostClient.ws, { type: "cmd_spawn_wave", wave: rd.wave, total });
  console.log(`[wave] room=${room} wave=${rd.wave} total=${total}`);
}

// Спавн боса
function spawnBoss(room) {
  const rd = getOrCreateRoom(room);
  if (rd.boss_zid >= 0) return; // вже є бос
  const bossHp = 2000 + rd.wave * 500;
  const zid = nextZid++;
  const bx = (Math.random()-0.5)*40, bz = (Math.random()-0.5)*40;
  zombies.set(zid, { room, type: 99, x: bx, z: bz, health: bossHp });
  rd.boss_zid = zid; rd.boss_hp = bossHp; rd.boss_max_hp = bossHp;
  // Кат-сцена + спавн
  broadcastAll(room, { type: "boss_cutscene", wave: rd.wave });
  setTimeout(() => {
    broadcastAll(room, { type: "boss_spawn", zid, hp: bossHp, max_hp: bossHp, x: bx, z: bz });
    // Командуємо хосту спавнити боса локально
    const hostId = getRoomHost(room);
    const hostClient = clients.get(hostId);
    if (hostClient) send(hostClient.ws, { type: "cmd_spawn_boss", zid, hp: bossHp, x: bx, z: bz });
  }, 6000); // 6 сек кат-сцена
  console.log(`[boss] room=${room} zid=${zid} hp=${bossHp}`);
}

wss.on("connection", (ws) => {
  const id = nextId++;
  clients.set(id, { id, ws, name: "Гравець"+id, skin:0, x:0, y:0, z:0, rot:0, health:100, kills:0, room:null });
  send(ws, { type: "welcome", id });

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const c = clients.get(id); if (!c) return;

    switch (msg.type) {
      case "get_rooms":
        send(ws, { type: "room_list", rooms: getRoomList() }); break;

      case "join": {
        c.room = msg.room || "default";
        c.name = (msg.name || c.name).slice(0, 24);
        c.skin = msg.skin || 0; c.kills = 0;
        const rd = getOrCreateRoom(c.room);
        // Перший гравець — хост
        if (getRoomHost(c.room) === id || rd.hostId === -1) rd.hostId = id;
        broadcast(c.room, { type: "player_joined", id, name: c.name, skin: c.skin }, id);
        const existing = roomPlayers(c.room).filter(p => p.id !== id);
        const roomZ = [];
        for (const [zid, z] of zombies)
          if (z.room === c.room) roomZ.push({ zid, ztype: z.type, x: z.x, z: z.z, health: z.health });
        send(ws, { type: "room_state", players: existing, zombies: roomZ, wave: rd.wave, is_host: id === rd.hostId });
        if (rd.boss_zid >= 0)
          send(ws, { type: "boss_spawn", zid: rd.boss_zid, hp: rd.boss_hp, max_hp: rd.boss_max_hp });
        for (const [, cl] of clients)
          if (cl.ws.readyState === WebSocket.OPEN)
            cl.ws.send(JSON.stringify({ type: "room_list", rooms: getRoomList() }));
        // Якщо перший гравець — стартуємо хвилю
        if (existing.length === 0) setTimeout(() => startWave(c.room), 2000);
        break;
      }

      case "move":
        c.x=msg.x; c.y=msg.y; c.z=msg.z; c.rot=msg.rot||0;
        broadcast(c.room, { type:"move", id, x:c.x, y:c.y, z:c.z, rot:c.rot }, id); break;

      case "health":
        c.health = msg.health;
        broadcast(c.room, { type:"health", id, health:c.health }, id); break;

      case "weapon":
        broadcast(c.room, { type:"weapon", id, weapon:msg.weapon }, id); break;

      case "zombie_spawn": {
        const zid = nextZid++;
        zombies.set(zid, { room:c.room, type:msg.ztype, x:msg.x, z:msg.z, health:msg.health||100 });
        broadcastAll(c.room, { type:"zombie_spawn", zid, ztype:msg.ztype, x:msg.x, z:msg.z, health:msg.health||100 });
        break;
      }

      case "zombie_move": {
        const z = zombies.get(msg.zid);
        if (z) { z.x=msg.x; z.z=msg.z; }
        broadcast(c.room, { type:"zombie_move", zid:msg.zid, x:msg.x, z:msg.z }, id); break;
      }

      case "zombie_hit": {
        const z = zombies.get(msg.zid);
        if (!z || z.room !== c.room) break;
        const rd = getOrCreateRoom(c.room);
        const isBoss = msg.zid === rd.boss_zid;
        z.health -= msg.dmg;
        if (z.health <= 0) {
          zombies.delete(msg.zid);
          c.kills++;
          rd.totalKills++;
          broadcastAll(c.room, { type:"zombie_died", zid:msg.zid, killer_id:id, isBoss });
          broadcastAll(c.room, { type:"leaderboard", board:getLeaderboard(c.room) });
          if (isBoss) {
            rd.boss_zid = -1; rd.boss_hp = 0;
            broadcastAll(c.room, { type:"boss_dead" });
            // Після боса — нова хвиля
            setTimeout(() => startWave(c.room), 5000);
          } else {
            // Перевіряємо чи треба спавнити боса (кожні 50 кілів)
            if (rd.totalKills >= rd.bossKillThreshold && rd.boss_zid < 0) {
              rd.bossKillThreshold += 50;
              spawnBoss(c.room);
            }
            // Перевіряємо чи всі зомбі кімнати вбиті
            const roomZombies = [...zombies.values()].filter(z => z.room === c.room && z.type !== 99);
            if (roomZombies.length === 0 && rd.waveActive && rd.boss_zid < 0) {
              rd.waveActive = false;
              setTimeout(() => startWave(c.room), 4000);
            }
          }
        } else {
          if (isBoss) {
            rd.boss_hp = z.health;
            broadcastAll(c.room, { type:"boss_hp", hp:z.health, max_hp:rd.boss_max_hp });
          } else {
            broadcast(c.room, { type:"zombie_hit", zid:msg.zid, health:z.health }, id);
          }
        }
        break;
      }

      case "chat":
        broadcastAll(c.room, { type:"chat", id, name:c.name, text:String(msg.text||"").slice(0,120) }); break;

      case "shoot":
        broadcast(c.room, { type:"shoot", id, weapon:msg.weapon, from_x:msg.from_x, from_z:msg.from_z, to_x:msg.to_x, to_z:msg.to_z }, id); break;

      case "explosion":
        broadcast(c.room, { type:"explosion", x:msg.x, y:msg.y, z:msg.z, radius:msg.radius }, id); break;
    }
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (c && c.room) {
      broadcast(c.room, { type:"player_left", id });
      // Якщо хост вийшов — передаємо хостинг
      const rd = getOrCreateRoom(c.room);
      if (rd.hostId === id) {
        const newHost = getRoomHost(c.room);
        if (newHost !== id && newHost >= 0) {
          rd.hostId = newHost;
          const nhClient = clients.get(newHost);
          if (nhClient) send(nhClient.ws, { type:"become_host" });
        }
      }
    }
    clients.delete(id);
    for (const [, cl] of clients)
      if (cl.ws.readyState === WebSocket.OPEN)
        cl.ws.send(JSON.stringify({ type:"room_list", rooms:getRoomList() }));
  });
});

httpServer.listen(PORT);
console.log(`Server on port ${PORT}`);

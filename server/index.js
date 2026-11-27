// HTTP static server + WebSocket game server: accounts, friends, lobbies, games.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Engine } from '../public/shared/engine.js';
import { COLORS, TICK_MS } from '../public/shared/rules.js';
import { openStore } from './store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '..', 'data');
const PORT = +process.env.PORT || 8080;

// ---------------- persistence ----------------
const store = await openStore({ dataDir: DATA_DIR, databaseUrl: process.env.DATABASE_URL });
let db = (await store.loadDb()) || { users: {}, tokens: {} };
db.users ||= {}; db.tokens ||= {};
console.log(`Loaded ${Object.keys(db.users).length} accounts`);
let saveTimer = null, saving = Promise.resolve(), dirty = false;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty) return saving;
  dirty = false; const json = JSON.stringify(db);
  saving = saving.then(() => store.saveDb(json)).catch((e) => { console.error('save failed', e.message); dirty = true; saveTimer = setTimeout(flush, 3000); });
  return saving;
}
function save() { dirty = true; if (!saveTimer) saveTimer = setTimeout(flush, 400); }
// save before the host stops or restarts the server
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await flush(); await store.close(); } finally { process.exit(0); } });
const key = (u) => String(u || '').trim().toLowerCase();
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

// ---------------- connections ----------------
const online = new Map(); // userKey -> Set(ws)
const lobbies = new Map(); // code -> lobby
const userLobby = new Map(); // userKey -> code

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendUser(k, msg) { for (const ws of online.get(k) || []) send(ws, msg); }
function err(ws, msg) { send(ws, { t: 'error', msg }); }

function friendState(k) {
  const u = db.users[k];
  const f = (n) => ({ username: db.users[n]?.username || n, av: db.users[n]?.av || 0, online: online.has(n), lobby: userLobby.get(n) || null });
  return { t: 'friends', friends: u.friends.map(f), incoming: u.incoming.map(n => db.users[n]?.username || n), outgoing: u.outgoing.map(n => db.users[n]?.username || n) };
}
function pushFriends(k) { if (db.users[k]) sendUser(k, friendState(k)); }
function pushFriendsOfFriends(k) { for (const f of db.users[k]?.friends || []) pushFriends(f); }

// ---------------- lobbies ----------------
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from({ length: 5 }, () => A[(Math.random() * A.length) | 0]).join(''); } while (lobbies.has(c));
  return c;
}
function lobbyView(l) {
  return {
    code: l.code, host: db.users[l.host].username, state: l.state, settings: l.settings, chat: l.chat.slice(-60),
    members: l.members.map(m => ({ username: db.users[m.k].username, ready: m.ready, color: m.color, av: db.users[m.k].av || 0, online: online.has(m.k), wins: db.users[m.k].stats?.wins || 0 })),
  };
}
function pushLobby(l) { const v = lobbyView(l); for (const m of l.members) sendUser(m.k, { t: 'lobby', lobby: v }); }
function freeColor(l) { return COLORS.find(c => !l.members.some(m => m.color === c)) || COLORS[0]; }
function sysChat(l, text) { l.chat.push({ from: null, text, at: Date.now() }); }

function joinLobby(k, code, ws) {
  const l = lobbies.get(code);
  if (!l) return err(ws, 'No room with that code.');
  if (l.members.some(m => m.k === k)) { userLobby.set(k, code); pushLobby(l); if (l.state === 'game') sendGameStart(l, k); return; }
  if (l.state !== 'lobby') return err(ws, 'That game already started.');
  if (l.banned.has(k)) return err(ws, 'You were removed from that room.');
  if (l.members.length + l.settings.bots >= 20 || l.members.length >= l.settings.maxPlayers) return err(ws, 'That room is full.');
  leaveLobby(k);
  l.members.push({ k, ready: false, color: freeColor(l) });
  userLobby.set(k, code);
  sysChat(l, `${db.users[k].username} joined`);
  pushLobby(l); pushFriendsOfFriends(k);
}
function leaveLobby(k) {
  const code = userLobby.get(k); if (!code) return;
  userLobby.delete(k);
  const l = lobbies.get(code); if (!l) return;
  if (l.state === 'game') { pushFriendsOfFriends(k); return; } // stays in the match; can come back
  l.members = l.members.filter(m => m.k !== k);
  sendUser(k, { t: 'lobby', lobby: null });
  if (!l.members.length) { closeLobby(l); return; }
  if (l.host === k) { l.host = l.members[0].k; sysChat(l, `${db.users[l.host].username} is now the leader`); }
  sysChat(l, `${db.users[k].username} left`);
  pushLobby(l); pushFriendsOfFriends(k);
}

// Stop any timers a room has running and forget it.
function closeLobby(l) {
  clearTimeout(l.cdTimer); clearInterval(l.loop);
  if (l.state === 'countdown') for (const m of l.members) sendUser(m.k, { t: 'countdown', n: -1 });
  l.state = 'closed'; lobbies.delete(l.code);
}
function startCountdown(l) {
  l.state = 'countdown'; let n = 5;
  const tick = () => {
    if (l.state !== 'countdown') return;
    for (const m of l.members) sendUser(m.k, { t: 'countdown', n });
    if (n === 0) return startGame(l);
    n--; l.cdTimer = setTimeout(tick, 1000);
  };
  pushLobby(l); tick();
}

const BOT_NAMES = ['Atlas', 'Boreal', 'Cobalt', 'Dune', 'Ember', 'Falcon', 'Granite', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Monsoon', 'Nova', 'Onyx', 'Pike', 'Quartz', 'Raven', 'Sable', 'Tundra'];
function startGame(l) {
  const players = l.members.map(m => ({ id: m.k, name: db.users[m.k].username, color: m.color }));
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < l.settings.bots; i++) {
    const used = new Set(players.map(p => p.color));
    players.push({ id: 'bot' + i, name: names[i] + ' AI', color: COLORS.find(c => !used.has(c)) || COLORS[i % COLORS.length], isBot: true, country: `Republic of ${names[i]}` });
  }
  l.game = new Engine({ players, settings: { spawnTime: l.settings.spawnTime, startMoney: l.settings.startMoney, winPercent: l.settings.winPercent, tribes: l.settings.tribes !== false, botLevel: l.settings.botLevel || 'medium' } });
  l.state = 'game';
  for (const m of l.members) sendGameStart(l, m.k);
  pushLobby(l);
  l.loop = setInterval(() => gameTick(l), TICK_MS);
}
function sendGameStart(l, k) {
  const idx = l.game.players.findIndex(p => p.id === k);
  sendUser(k, { t: 'game_start', you: idx, snap: l.game.snapshot() });
}
function gameTick(l) {
  // nobody watching for 2 minutes: end the match instead of running it forever
  if (l.game.tick % 100 === 0) {
    const watching = l.members.some(m => online.has(m.k) && userLobby.get(m.k) === l.code);
    if (watching) l.emptySince = 0; else if (!l.emptySince) l.emptySince = Date.now();
    else if (Date.now() - l.emptySince > 120000) {
      for (const m of l.members) if (userLobby.get(m.k) === l.code) userLobby.delete(m.k);
      return closeLobby(l);
    }
  }
  const patch = l.game.step();
  const shared = patch.ev.filter(e => !e.to);
  const byUser = new Map();
  for (const e of patch.ev) if (e.to) { if (!byUser.has(e.to)) byUser.set(e.to, []); byUser.get(e.to).push(e); }
  const base = JSON.stringify({ ...patch, ev: shared });
  for (const m of l.members) {
    if (userLobby.get(m.k) !== l.code) continue;
    const mine = byUser.get(m.k);
    const data = mine ? JSON.stringify({ t: 'p', ...patch, ev: shared.concat(mine) }) : '{"t":"p",' + base.slice(1);
    for (const ws of online.get(m.k) || []) if (ws.readyState === 1) ws.send(data);
  }
  if (l.game.phase === 'over') {
    clearInterval(l.loop);
    const win = l.game.players[l.game.winner];
    for (const m of l.members) { const u = db.users[m.k]; u.stats = u.stats || { games: 0, wins: 0 }; u.stats.games++; if (win && win.id === m.k) u.stats.wins++; }
    save();
    l.state = 'lobby'; l.game = null;
    for (const m of l.members) m.ready = false;
    sysChat(l, win ? `${win.country} (${win.name}) won the war!` : 'Game over');
    // drop members who left during the match
    l.members = l.members.filter(m => userLobby.get(m.k) === l.code);
    if (!l.members.length) { closeLobby(l); return; }
    if (!l.members.some(m => m.k === l.host)) l.host = l.members[0].k;
    setTimeout(() => pushLobby(l), 500);
  }
}

// Remove an account and every trace of it (Google Play requires account deletion).
function deleteAccount(k) {
  const u = db.users[k]; if (!u) return 'No such account.';
  for (const l of lobbies.values()) if (l.state !== 'lobby' && l.members.some(m => m.k === k)) return 'Leave your match first, then delete your account.';
  leaveLobby(k);
  for (const o of Object.values(db.users)) { o.friends = o.friends.filter(x => x !== k); o.incoming = o.incoming.filter(x => x !== k); o.outgoing = o.outgoing.filter(x => x !== k); }
  for (const [t, v] of Object.entries(db.tokens)) if (v === k) delete db.tokens[t];
  const friends = u.friends;
  delete db.users[k]; save();
  store.dropAvatar(k).catch(() => {});
  for (const f of friends) pushFriends(f);
  for (const ws of online.get(k) || []) { send(ws, { t: 'deleted' }); ws.user = null; }
  online.delete(k);
  return null;
}
function checkPassword(name, pw) { const k = key(name), u = db.users[k]; return u && hashPw(String(pw || ''), u.salt) === u.hash ? k : null; }

// ---------------- message handling ----------------
const LIMITS = { maxPlayers: [2, 16], bots: [0, 15], startMoney: [0, 50000], spawnTime: [5, 60], winPercent: [30, 100] };
function handle(ws, msg) {
  const k = ws.user;
  if (!k) {
    if (msg.t === 'register' || msg.t === 'login') {
      // slow down password guessing: at most 6 tries per 30 seconds per connection
      const now = Date.now(); ws.tries = (ws.tries || []).filter(t => now - t < 30000); ws.tries.push(now);
      if (ws.tries.length > 6) return err(ws, 'Too many tries. Wait a few seconds and try again.');
      const name = String(msg.username || '').trim(), pw = String(msg.password || '');
      const nk = key(name);
      if (msg.t === 'register') {
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return err(ws, 'Username must be 3-16 letters, numbers or _.');
        if (pw.length < 4) return err(ws, 'Password must be at least 4 characters.');
        if (db.users[nk]) return err(ws, 'That username is taken.');
        const salt = crypto.randomBytes(16).toString('hex');
        db.users[nk] = { username: name, salt, hash: hashPw(pw, salt), friends: [], incoming: [], outgoing: [], stats: { games: 0, wins: 0 }, created: Date.now() };
      } else {
        const u = db.users[nk];
        if (!u) return err(ws, `There's no account called ${name.slice(0, 16)}. Check the spelling, or tap Create account.`);
        if (hashPw(pw, u.salt) !== u.hash) return err(ws, 'Wrong password for that username.');
      }
      const token = crypto.randomBytes(24).toString('hex');
      db.tokens[token] = nk; save();
      return authed(ws, nk, token);
    }
    if (msg.t === 'resume') {
      const nk = db.tokens[msg.token];
      if (!nk || !db.users[nk]) return send(ws, { t: 'auth_fail' });
      return authed(ws, nk, msg.token);
    }
    return;
  }
  const u = db.users[k];
  switch (msg.t) {
    case 'logout': delete db.tokens[msg.token]; save(); ws.close(); return;
    case 'delete_account': {
      if (!checkPassword(u.username, msg.password)) return err(ws, 'That password isn\'t right.');
      const e = deleteAccount(k); if (e) return err(ws, e);
      return;
    }
    case 'friend_add': {
      const fk = key(msg.username);
      if (!db.users[fk]) return err(ws, 'No player with that username.');
      if (fk === k) return err(ws, 'That\'s you!');
      if (u.friends.includes(fk)) return err(ws, 'Already friends.');
      if (u.incoming.includes(fk)) return handle(ws, { t: 'friend_accept', username: msg.username });
      if (!u.outgoing.includes(fk)) { u.outgoing.push(fk); db.users[fk].incoming.push(k); }
      save(); pushFriends(k); pushFriends(fk);
      sendUser(fk, { t: 'toast', msg: `${u.username} sent you a friend request` });
      return;
    }
    case 'friend_accept': {
      const fk = key(msg.username); const f = db.users[fk]; if (!f || !u.incoming.includes(fk)) return;
      u.incoming = u.incoming.filter(x => x !== fk); f.outgoing = f.outgoing.filter(x => x !== k);
      if (!u.friends.includes(fk)) u.friends.push(fk); if (!f.friends.includes(k)) f.friends.push(k);
      save(); pushFriends(k); pushFriends(fk);
      sendUser(fk, { t: 'toast', msg: `${u.username} accepted your friend request` });
      return;
    }
    case 'friend_remove': {
      const fk = key(msg.username); const f = db.users[fk]; if (!f) return;
      for (const [a, b] of [[u, fk], [f, k]]) { a.friends = a.friends.filter(x => x !== b); a.incoming = a.incoming.filter(x => x !== b); a.outgoing = a.outgoing.filter(x => x !== b); }
      save(); pushFriends(k); pushFriends(fk); return;
    }
    case 'lobby_create': {
      leaveLobby(k);
      const code = newCode();
      const l = { code, host: k, members: [{ k, ready: true, color: COLORS[0] }], state: 'lobby', chat: [], banned: new Set(),
        settings: { maxPlayers: 8, bots: 4, startMoney: 1000, spawnTime: 20, winPercent: 60, tribes: true, botLevel: 'medium', public: !!msg.public, name: `${u.username}'s room` } };
      lobbies.set(code, l); userLobby.set(k, code);
      sysChat(l, 'Room created. Share the code or invite friends!');
      pushLobby(l); pushFriendsOfFriends(k); return;
    }
    case 'lobby_join': return joinLobby(k, String(msg.code || '').trim().toUpperCase(), ws);
    case 'lobby_leave': return leaveLobby(k);
    case 'profile_get': {
      const pk = key(msg.username), p = db.users[pk]; if (!p) return err(ws, 'No player with that username.');
      return send(ws, { t: 'profile', profile: { username: p.username, av: p.av || 0, bio: p.bio || '', stats: p.stats || { games: 0, wins: 0 }, created: p.created || 0,
        online: online.has(pk), lobby: userLobby.get(pk) || null, me: pk === k, friend: u.friends.includes(pk), pending: u.outgoing.includes(pk), incoming: u.incoming.includes(pk), friends: p.friends.length } });
    }
    case 'profile_update': {
      if (typeof msg.bio === 'string') u.bio = msg.bio.slice(0, 160);
      if (typeof msg.avatar === 'string') {
        const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(msg.avatar);
        if (!m || m[2].length > 400000) return err(ws, 'That picture is too big. Try another one.');
        store.putAvatar(k, Buffer.from(m[2], 'base64')).catch(e => console.error('avatar save failed', e.message));
        u.avType = 'image/' + m[1]; u.av = Date.now();
      }
      if (msg.avatar === null) { u.av = 0; store.dropAvatar(k).catch(() => {}); }
      save();
      send(ws, { t: 'auth', token: null, user: { username: u.username, stats: u.stats, av: u.av || 0, bio: u.bio || '' } });
      handle(ws, { t: 'profile_get', username: u.username });
      pushFriendsOfFriends(k);
      const l = lobbies.get(userLobby.get(k)); if (l) pushLobby(l);
      return;
    }
    case 'lobby_list': {
      const list = [...lobbies.values()].filter(l => l.settings.public && l.state === 'lobby').map(l => ({ code: l.code, name: l.settings.name, players: l.members.length, max: l.settings.maxPlayers, bots: l.settings.bots, level: l.settings.botLevel || 'medium', host: db.users[l.host].username }));
      return send(ws, { t: 'lobby_list', lobbies: list });
    }
  }
  const l = lobbies.get(userLobby.get(k));
  if (!l) return;
  const isHost = l.host === k;
  switch (msg.t) {
    case 'lobby_chat': case 'game_chat': {
      const text = String(msg.text || '').trim().slice(0, 200); if (!text) return;
      const entry = { from: u.username, text, at: Date.now() };
      if (msg.t === 'game_chat' && l.state === 'game') { for (const m of l.members) sendUser(m.k, { t: 'game_chat', ...entry }); return; }
      l.chat.push(entry); if (l.chat.length > 200) l.chat.shift(); pushLobby(l); return;
    }
    case 'lobby_ready': { const m = l.members.find(x => x.k === k); if (m) m.ready = !!msg.ready; pushLobby(l); return; }
    case 'lobby_color': { const c = COLORS.includes(msg.color) && !l.members.some(m => m.color === msg.color) ? msg.color : null; const m = l.members.find(x => x.k === k); if (c && m) m.color = c; pushLobby(l); return; }
    case 'lobby_invite': {
      const fk = key(msg.username); if (!u.friends.includes(fk)) return err(ws, 'You can only invite friends.');
      if (!online.has(fk)) return err(ws, `${db.users[fk].username} is offline.`);
      sendUser(fk, { t: 'invite', from: u.username, code: l.code });
      sendUser(k, { t: 'toast', msg: `Invite sent to ${db.users[fk].username}` }); return;
    }
    case 'lobby_settings': {
      if (!isHost || l.state !== 'lobby') return;
      const s = msg.settings || {};
      for (const [f, [lo, hi]] of Object.entries(LIMITS)) if (s[f] !== undefined && Number.isFinite(+s[f])) l.settings[f] = Math.round(Math.min(hi, Math.max(lo, +s[f])));
      if (s.public !== undefined) l.settings.public = !!s.public;
      if (s.tribes !== undefined) l.settings.tribes = !!s.tribes;
      if (['easy', 'medium', 'hard'].includes(s.botLevel)) l.settings.botLevel = s.botLevel;
      if (typeof s.name === 'string') l.settings.name = s.name.slice(0, 40) || l.settings.name;
      pushLobby(l); return;
    }
    case 'lobby_kick': {
      if (!isHost) return; const fk = key(msg.username); if (fk === k) return;
      if (l.state !== 'lobby') return;
      l.banned.add(fk); leaveLobby(fk); sendUser(fk, { t: 'toast', msg: 'You were removed from the room.' }); return;
    }
    case 'lobby_transfer': { if (!isHost) return; const fk = key(msg.username); if (l.members.some(m => m.k === fk)) { l.host = fk; sysChat(l, `${db.users[fk].username} is now the leader`); pushLobby(l); } return; }
    case 'lobby_start': {
      if (!isHost || l.state !== 'lobby') return;
      if (l.members.length + l.settings.bots < 2) return err(ws, 'You need at least one more player or bot.');
      return startCountdown(l);
    }
    case 'lobby_cancel': { if (isHost && l.state === 'countdown') { clearTimeout(l.cdTimer); l.state = 'lobby'; for (const m of l.members) sendUser(m.k, { t: 'countdown', n: -1 }); pushLobby(l); } return; }
    case 'act': if (l.state === 'game' && l.game) l.game.handle(k, msg.a); return;
  }
}

function authed(ws, k, token) {
  ws.user = k;
  if (!online.has(k)) online.set(k, new Set());
  online.get(k).add(ws);
  const u = db.users[k];
  send(ws, { t: 'auth', token, user: { username: u.username, stats: u.stats || { games: 0, wins: 0 }, av: u.av || 0, bio: u.bio || '' } });
  send(ws, friendState(k));
  pushFriendsOfFriends(k);
  const code = userLobby.get(k);
  const l = code && lobbies.get(code);
  if (l) { send(ws, { t: 'lobby', lobby: lobbyView(l) }); if (l.state === 'game') { const idx = l.game.players.findIndex(p => p.id === k); send(ws, { t: 'game_start', you: idx, snap: l.game.snapshot() }); } }
  else {
    // rejoin a running match we were part of
    let found = false;
    for (const g of lobbies.values()) if (g.state === 'game' && g.members.some(m => m.k === k)) { userLobby.set(k, g.code); send(ws, { t: 'lobby', lobby: lobbyView(g) }); sendGameStart(g, k); found = true; break; }
    if (!found) send(ws, { t: 'lobby', lobby: null });
  }
}

// ---------------- http ----------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg' };
const deleteHits = new Map();
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.startsWith('/avatar/')) {
    const ak = key(p.slice(8)), au = db.users[ak];
    if (!au || !au.av) { res.writeHead(404); return res.end(); }
    return store.getAvatar(ak).then((data) => {
      if (!data) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': au.avType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); res.end(data);
    }, () => { res.writeHead(500); res.end(); });
  }
  // Android app link verification. Paste the file's contents into the ASSET_LINKS setting on the host,
  // or commit it as public/.well-known/assetlinks.json.
  if (p === '/.well-known/assetlinks.json' && process.env.ASSET_LINKS) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(process.env.ASSET_LINKS); }
  // quick health check for the owner: where accounts are saved and how long the server has been up
  if (p === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ accountsSavedIn: store.kind === 'database' ? 'database (safe)' : 'temporary files (lost on restart!)', accounts: Object.keys(db.users).length, rooms: lobbies.size, upMinutes: Math.round(process.uptime() / 60) }, null, 1));
  }
  // account deletion from the web (linked from the privacy page and the Play listing)
  if (p === '/api/delete-account' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let m = {}; try { m = JSON.parse(body); } catch { /* bad json */ }
      const now = Date.now(), ip = req.socket.remoteAddress || '';
      const hits = (deleteHits.get(ip) || []).filter(t => now - t < 60000); hits.push(now); deleteHits.set(ip, hits);
      const reply = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg })); };
      if (hits.length > 5) return reply(429, 'Too many tries. Wait a minute and try again.');
      const k = checkPassword(m.username, m.password);
      if (!k) return reply(403, 'Wrong username or password.');
      const e = deleteAccount(k); if (e) return reply(409, e);
      reply(200, 'Your account and everything saved with it has been deleted.');
    });
    return;
  }
  if (p === '/' || p.startsWith('/join/')) p = '/index.html';
  if (p === '/privacy' || p === '/delete-account') p += '.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  serveStatic(req, res, file);
});
// Static files are read once, gzipped once, and served with an ETag so repeat visits are a quick 304.
const fileCache = new Map();
function serveStatic(req, res, file) {
  const send = (f) => {
    if (!f) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
    if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); return res.end(f.gz); }
    res.writeHead(200, headers); res.end(f.data);
  };
  if (fileCache.has(file)) return send(fileCache.get(file));
  fs.readFile(file, (e, data) => {
    if (e) return send(null);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const f = { data, type, etag: '"' + crypto.createHash('sha1').update(data).digest('base64').slice(0, 16) + '"',
      gz: /text|javascript|json|svg|manifest/.test(type) && data.length > 1024 ? zlib.gzipSync(data, { level: 9 }) : null };
    fileCache.set(file, f); send(f);
  });
}
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (data) => { let msg; try { msg = JSON.parse(data); } catch { return; } try { handle(ws, msg); } catch (e) { console.error(e); } });
  ws.on('close', () => {
    const k = ws.user; if (!k) return;
    const set = online.get(k); set?.delete(ws);
    if (set && !set.size) {
      online.delete(k);
      const code = userLobby.get(k), l = lobbies.get(code);
      // give people a moment to reconnect before removing them from a waiting lobby
      if (l && l.state === 'lobby') setTimeout(() => { if (!online.has(k)) leaveLobby(k); }, 15000);
      else if (l) pushLobby(l);
      pushFriendsOfFriends(k);
    }
  });
});
server.listen(PORT, () => console.log(`World War server on http://localhost:${PORT}`));

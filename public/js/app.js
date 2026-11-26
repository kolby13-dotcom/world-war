// App shell: accounts, home screen, friends, profiles, lobbies, and starting matches.
import { ClientGame } from './game.js';
import { Engine } from '../shared/engine.js';
import { COLORS, TICK_MS } from '../shared/rules.js';
import { paintRange } from './game.js';

const $ = (s, r = document) => r.querySelector(s);
const OFFLINE_ONLY = !!window.WW_OFFLINE;
const store = {
  get(k) { try { return localStorage.getItem('ww_' + k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem('ww_' + k); else localStorage.setItem('ww_' + k, v); } catch { /* storage blocked */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { user: null, token: store.get('token'), friends: { friends: [], incoming: [], outgoing: [] }, lobby: null, game: null, ws: null, connected: false, pendingJoin: null, offlineLoop: null };

// ---------------- networking ----------------
let retry = 0;
function connect() {
  if (OFFLINE_ONLY) { setConn(false); return; }
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  state.ws = ws;
  ws.onopen = () => { retry = 0; setConn(true); if (state.token) send({ t: 'resume', token: state.token }); };
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { setConn(false); setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
}
function send(m) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(m)); }
function setConn(ok) {
  state.connected = ok;
  $('#conn').classList.toggle('hidden', ok || OFFLINE_ONLY || retry < 2);
  $('#online-auth').classList.toggle('hidden', OFFLINE_ONLY);
  $('#offline-note').classList.toggle('hidden', !OFFLINE_ONLY);
}

function onMsg(m) {
  switch (m.t) {
    case 'auth':
      if (m.token) { state.token = m.token; store.set('token', m.token); }
      state.user = m.user; renderMe();
      if (!state.lobby && !state.game) show('home');
      if (state.pendingJoin) { send({ t: 'lobby_join', code: state.pendingJoin }); state.pendingJoin = null; }
      break;
    case 'auth_fail': state.token = null; store.set('token', null); show('auth'); break;
    case 'error': toast(m.msg, 'error'); authMsg(m.msg); break;
    case 'toast': toast(m.msg); break;
    case 'friends': state.friends = m; renderFriends(); break;
    case 'lobby':
      state.lobby = m.lobby;
      if (!m.lobby) { if (!state.game) show('home'); break; }
      if (!state.game) show('lobby');
      renderLobby(); break;
    case 'lobby_list': renderLobbyList(m.lobbies); break;
    case 'invite': inviteToast(m.from, m.code); break;
    case 'countdown': countdown(m.n); break;
    case 'game_start': startOnlineGame(m); break;
    case 'p': if (state.game) state.game.applyPatch(m); break;
    case 'game_chat': state.game?.chat(m); break;
    case 'profile': renderProfile(m.profile); break;
  }
}

// ---------------- screens ----------------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  if (id === 'home' && state.connected) send({ t: 'lobby_list' });
}
function toast(text, kind = 'info') {
  if (state.game) return state.game.toast(text, kind);
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text;
  $('#toasts').prepend(t); setTimeout(() => t.classList.add('fade'), 3500); setTimeout(() => t.remove(), 4200);
}
function authMsg(t) { const el = $('#auth-msg'); if (el && !$('#auth').classList.contains('hidden')) el.textContent = t; }
function avatarUrl(username, av) {
  if (OFFLINE_ONLY || !state.connected) return store.get('avatar') || '';
  return av ? `/avatar/${encodeURIComponent(username)}?v=${av}` : '';
}
function avatarHtml(username, av, cls = '') {
  const url = avatarUrl(username, av);
  const letter = esc((username || '?')[0].toUpperCase());
  return url ? `<span class="avatar ${cls}"><img src="${esc(url)}" alt=""></span>` : `<span class="avatar ${cls}">${letter}</span>`;
}

function renderMe() {
  const u = state.user; if (!u) return;
  const hour = new Date().getHours(), hi = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#me-chip').innerHTML = `${avatarHtml(u.username, u.av)}<span style="min-width:0"><small>${hi}</small><b>${esc(u.username)}</b></span>`;
}

// ---------------- auth ----------------
let authMode = 'login';
function setupAuth() {
  for (const b of document.querySelectorAll('.auth-tab')) b.onclick = () => {
    authMode = b.dataset.m; for (const o of document.querySelectorAll('.auth-tab')) o.classList.toggle('active', o === b);
    $('#auth-go').textContent = authMode === 'login' ? 'Log in' : 'Create account'; $('#auth-msg').textContent = '';
  };
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    if (!state.connected) return authMsg('Can\'t reach the server right now. You can still practice offline.');
    send({ t: authMode, username: $('#auth-user').value, password: $('#auth-pass').value });
  };
  $('#auth-offline').onclick = () => openPractice();
  const saved = store.get('offline_name'); if (saved) $('#offline-name').value = saved;
}

// ---------------- home ----------------
function setupHome() {
  $('#b-create').onclick = () => send({ t: 'lobby_create', public: $('#create-public').checked });
  $('#join-form').onsubmit = (e) => { e.preventDefault(); const c = $('#join-code').value.trim(); if (c) send({ t: 'lobby_join', code: c }); };
  $('#b-refresh').onclick = () => send({ t: 'lobby_list' });
  $('#b-practice').onclick = () => openPractice();
  $('#me-chip').onclick = () => openProfile(state.user.username);
  $('#b-logout').onclick = () => { send({ t: 'logout', token: state.token }); state.token = null; store.set('token', null); state.user = null; show('auth'); };
  for (const t of document.querySelectorAll('.tabbar .tab')) t.onclick = () => {
    if (t.dataset.tab === 'me') return openProfile(state.user.username);
    for (const o of document.querySelectorAll('.tabbar .tab')) o.classList.toggle('active', o === t);
    for (const p of document.querySelectorAll('#home .tab-pane')) p.classList.toggle('active', p.dataset.pane === t.dataset.tab);
    if (t.dataset.tab === 'play') send({ t: 'lobby_list' });
  };
  $('#join-code').oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
  $('#friend-form').onsubmit = (e) => { e.preventDefault(); const n = $('#friend-name').value.trim(); if (n) send({ t: 'friend_add', username: n }); $('#friend-name').value = ''; };
}
function renderLobbyList(list) {
  const el = $('#lobby-list');
  el.innerHTML = list.length ? list.map(l => `<div class="row-card"><span class="pc-icon" style="width:42px;height:42px;font-size:20px;background:rgba(255,90,54,.15)">🌍</span><div class="rc-main"><b>${esc(l.name)}</b><small>${l.players}/${l.max} players · ${l.bots} ${esc(l.level || 'medium')} bots · ${esc(l.host)}</small></div><div class="rc-act"><button class="btn small primary" data-code="${esc(l.code)}">Join</button></div></div>`).join('')
    : '<div class="empty">No open rooms right now.<br>Create one and be the first.</div>';
  for (const b of el.querySelectorAll('[data-code]')) b.onclick = () => send({ t: 'lobby_join', code: b.dataset.code });
}
function renderFriends() {
  const f = state.friends;
  const badge = $('#friends-badge'); badge.textContent = f.incoming.length; badge.classList.toggle('hidden', !f.incoming.length);
  const friendRow = (fr, inLobby) => `<div class="row-card"><span data-prof="${esc(fr.username)}" style="cursor:pointer">${avatarHtml(fr.username, fr.av, 'sm')}</span>
      <div class="rc-main" data-prof="${esc(fr.username)}" style="cursor:pointer"><b>${esc(fr.username)}</b><small><span class="dot ${fr.online ? 'on' : ''}"></span> ${fr.lobby ? 'In a room' : fr.online ? 'Online' : 'Offline'}</small></div>
      <div class="rc-act">${inLobby && fr.online ? `<button class="btn small primary" data-inv="${esc(fr.username)}">Invite</button>` : ''}${!inLobby && fr.lobby ? `<button class="btn small primary" data-join="${esc(fr.lobby)}">Join</button>` : ''}</div></div>`;
  const html = (inLobby) => `
    ${f.incoming.length ? `<div class="list-label">Requests</div>${f.incoming.map(n => `<div class="row-card"><span class="avatar sm">${esc(n[0].toUpperCase())}</span><div class="rc-main"><b>${esc(n)}</b><small>wants to be friends</small></div><div class="rc-act"><button class="btn small go" data-acc="${esc(n)}">Accept</button><button class="btn small ghost" data-rem="${esc(n)}">✕</button></div></div>`).join('')}` : ''}
    ${f.friends.length ? `<div class="list-label">Friends · ${f.friends.filter(x => x.online).length} online</div>${[...f.friends].sort((a, b) => b.online - a.online).map(fr => friendRow(fr, inLobby)).join('')}`
      : `<div class="empty">${inLobby ? 'Add friends from the Friends tab to invite them here.' : 'No friends yet. Add someone by their username above.'}</div>`}
    ${f.outgoing.length && !inLobby ? `<div class="list-label">Sent</div>${f.outgoing.map(n => `<div class="row-card"><div class="rc-main"><b>${esc(n)}</b><small>Waiting for them to accept</small></div><div class="rc-act"><button class="btn small ghost" data-rem="${esc(n)}">Cancel</button></div></div>`).join('')}` : ''}`;
  for (const [sel, inLobby] of [['#friends-home', false], ['#friends-lobby', true]]) {
    const el = $(sel); el.innerHTML = html(inLobby);
    for (const b of el.querySelectorAll('[data-acc]')) b.onclick = () => send({ t: 'friend_accept', username: b.dataset.acc });
    for (const b of el.querySelectorAll('[data-rem]')) b.onclick = () => send({ t: 'friend_remove', username: b.dataset.rem });
    for (const b of el.querySelectorAll('[data-inv]')) b.onclick = () => send({ t: 'lobby_invite', username: b.dataset.inv });
    for (const b of el.querySelectorAll('[data-join]')) b.onclick = () => send({ t: 'lobby_join', code: b.dataset.join });
    for (const b of el.querySelectorAll('[data-prof]')) b.onclick = () => openProfile(b.dataset.prof);
  }
}
function inviteToast(from, code) {
  const t = document.createElement('div'); t.className = 'toast invite';
  t.innerHTML = `<span>🎮 <b>${esc(from)}</b> invited you to their room</span><button class="btn small primary">Join</button><button class="btn small">✕</button>`;
  const [join, x] = t.querySelectorAll('button');
  join.onclick = () => { send({ t: 'lobby_join', code }); t.remove(); }; x.onclick = () => t.remove();
  $('#toasts').prepend(t); setTimeout(() => t.remove(), 30000);
}

// ---------------- lobby ----------------
function setupLobby() {
  $('#b-leave').onclick = () => send({ t: 'lobby_leave' });
  $('#b-copy').onclick = () => copy(state.lobby.code, 'Code copied');
  $('#b-share').onclick = () => {
    const url = `${location.origin}/join/${state.lobby.code}`;
    if (navigator.share) navigator.share({ title: 'Join my World War game', text: `Join my game with code ${state.lobby.code}`, url }).catch(() => {});
    else copy(url, 'Invite link copied');
  };
  $('#b-ready').onclick = () => { requestLandscape(); const me = state.lobby.members.find(m => m.username === state.user.username); send({ t: 'lobby_ready', ready: !me?.ready }); };
  $('#b-start').onclick = () => { requestLandscape(); send({ t: 'lobby_start' }); };
  $('#lobby-chat-form').onsubmit = (e) => { e.preventDefault(); const i = $('#lobby-chat-in'); if (i.value.trim()) send({ t: 'lobby_chat', text: i.value }); i.value = ''; };
  for (const el of document.querySelectorAll('#lobby-settings [data-s]')) el.onchange = () => {
    const v = el.type === 'checkbox' ? el.checked : (el.type === 'text' || el.tagName === 'SELECT') ? el.value : +el.value;
    if (el.type === 'range') paintRange(el);
    send({ t: 'lobby_settings', settings: { [el.dataset.s]: v } });
  };
  $('#colors').innerHTML = COLORS.slice(0, 16).map(c => `<button class="swatch" data-c="${c}" style="background:${c}"></button>`).join('');
  for (const b of document.querySelectorAll('#colors .swatch')) b.onclick = () => send({ t: 'lobby_color', color: b.dataset.c });
  for (const el of document.querySelectorAll('#lobby-settings input[type=range]')) el.addEventListener('input', () => {
    paintRange(el); const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmtSetting(el.dataset.s, el.value);
  });
}
function fmtSetting(k, v) { return k === 'startMoney' ? '$' + (+v).toLocaleString() : k === 'winPercent' ? v + '%' : k === 'spawnTime' ? v + 's' : v; }
function copy(text, msg) { navigator.clipboard?.writeText(text).then(() => toast(msg), () => toast(text)); }
function renderLobby() {
  const l = state.lobby; if (!l) return;
  const isHost = l.host === state.user.username;
  $('#lobby-code').innerHTML = [...l.code].map(c => `<span>${esc(c)}</span>`).join('');
  $('#lobby-title').textContent = l.settings.name;
  $('#lobby-count').textContent = `${l.members.length} + ${l.settings.bots} ${l.settings.botLevel || 'medium'} bots`;
  $('#settings-note').textContent = isHost ? 'You\'re the leader' : 'Leader only';
  $('#lobby-members').innerHTML = l.members.map(m => `<div class="member ${m.online ? '' : 'away'}" style="--c:${m.color}">
      ${avatarHtml(m.username, m.av, 'sm')}
      <div class="rc-main" data-prof="${esc(m.username)}"><b>${esc(m.username)}</b><small>${m.wins} wins${m.online ? '' : ' · reconnecting'}</small></div>
      ${m.username === l.host ? '<span class="pill host">Leader</span>' : `<span class="pill ${m.ready ? 'yes' : ''}">${m.ready ? 'Ready' : 'Not ready'}</span>`}
      ${isHost && m.username !== state.user.username ? `<button class="btn small ghost" data-lead="${esc(m.username)}" title="Make leader" aria-label="Make leader">👑</button><button class="btn small danger" data-kick="${esc(m.username)}">Kick</button>` : ''}
    </div>`).join('') + Array.from({ length: l.settings.bots }, (_, i) => `<div class="member bot"><span class="avatar sm" style="background:var(--raised)">🤖</span><div class="rc-main"><b>Bot ${i + 1}</b><small>Fills an empty seat</small></div></div>`).join('');
  for (const b of document.querySelectorAll('#lobby-members [data-kick]')) b.onclick = () => send({ t: 'lobby_kick', username: b.dataset.kick });
  for (const b of document.querySelectorAll('#lobby-members [data-lead]')) b.onclick = () => send({ t: 'lobby_transfer', username: b.dataset.lead });
  for (const b of document.querySelectorAll('#lobby-members [data-prof]')) b.onclick = () => openProfile(b.dataset.prof);
  for (const el of document.querySelectorAll('#lobby-settings [data-s]')) {
    const v = l.settings[el.dataset.s];
    if (document.activeElement !== el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
    el.disabled = !isHost;
    if (el.type === 'range') paintRange(el);
    const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmtSetting(el.dataset.s, v);
  }
  const me = l.members.find(m => m.username === state.user.username);
  for (const b of document.querySelectorAll('#colors .swatch')) { b.classList.toggle('mine', me?.color === b.dataset.c); b.disabled = l.members.some(m => m.color === b.dataset.c && m !== me); }
  $('#b-ready').textContent = me?.ready ? 'Ready ✓' : 'I\'m ready';
  $('#b-ready').classList.toggle('go', !!me?.ready);
  $('#b-ready').classList.toggle('hidden', isHost);
  $('#b-start').classList.toggle('hidden', !isHost);
  const notReady = l.members.filter(m => !m.ready && m.username !== l.host).length;
  $('#b-start').textContent = notReady ? `Start · ${notReady} not ready` : 'Start game';
  $('#lobby-wait').classList.toggle('hidden', isHost || !me?.ready);
  $('#lobby-wait').textContent = `Waiting for ${l.host} to start`;
  const log = $('#lobby-chat');
  log.innerHTML = l.chat.map(c => c.from ? `<div><b>${esc(c.from)}</b> ${esc(c.text)}</div>` : `<div class="sys">${esc(c.text)}</div>`).join('');
  log.scrollTop = 1e9;
  renderFriends();
}

let cdTimer = null;
function countdown(n) {
  const el = $('#countdown');
  if (n < 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden'); $('#countdown b').textContent = n === 0 ? 'GO!' : n;
  $('#countdown b').classList.remove('pop'); void el.offsetWidth; $('#countdown b').classList.add('pop');
  clearTimeout(cdTimer); if (n === 0) cdTimer = setTimeout(() => el.classList.add('hidden'), 700);
}

// ---------------- matches ----------------
function startOnlineGame(m) {
  if (state.game) state.game.destroy();
  show('game');
  state.game = new ClientGame({
    root: $('#game'), you: m.you, snap: m.snap, username: state.user.username,
    send: (a) => send({ t: 'act', a }), onChat: (text) => send({ t: 'game_chat', text }),
    onExit: () => { state.game.destroy(); state.game = null; if (state.lobby && state.lobby.state !== 'game') { show('lobby'); renderLobby(); } else { send({ t: 'lobby_leave' }); show('home'); } },
  });
}

function openPractice() {
  const name = (store.get('offline_name') || state.user?.username || '');
  $('#practice-name').value = name; $('#practice-name-row').classList.toggle('hidden', !!state.user);
  $('#practice-modal').classList.remove('hidden');
}
function setupPractice() {
  $('#practice-cancel').onclick = () => $('#practice-modal').classList.add('hidden');
  const bots = $('#practice-bots'); bots.oninput = () => { $('#practice-bots-v').textContent = bots.value; paintRange(bots); }; paintRange(bots);
  for (const c of document.querySelectorAll('#practice-money-chips .chip')) c.onclick = () => {
    for (const o of document.querySelectorAll('#practice-money-chips .chip')) o.classList.toggle('on', o === c);
    $('#practice-money').value = c.dataset.v;
  };
  for (const c of document.querySelectorAll('#practice-level-chips .chip')) c.onclick = () => {
    for (const o of document.querySelectorAll('#practice-level-chips .chip')) o.classList.toggle('on', o === c);
    $('#practice-level').value = c.dataset.v; store.set('bot_level', c.dataset.v);
  };
  const savedLevel = store.get('bot_level');
  if (savedLevel) for (const c of document.querySelectorAll('#practice-level-chips .chip')) { c.classList.toggle('on', c.dataset.v === savedLevel); if (c.dataset.v === savedLevel) $('#practice-level').value = savedLevel; }
  $('#practice-go').onclick = () => {
    const name = state.user?.username || ($('#practice-name').value.trim().replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 16) || 'Commander');
    store.set('offline_name', name);
    $('#practice-modal').classList.add('hidden');
    requestLandscape();
    const nb = +bots.value, money = +$('#practice-money').value, level = $('#practice-level').value;
    let n = 5; const tick = () => { countdown(n); if (n === 0) return startPractice(name, nb, money, level); n--; setTimeout(tick, 1000); }; tick();
  };
}
const BOT_NAMES = ['Atlas', 'Boreal', 'Cobalt', 'Dune', 'Ember', 'Falcon', 'Granite', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Monsoon', 'Nova', 'Onyx', 'Pike', 'Quartz', 'Raven', 'Sable'];
function startPractice(name, nb, money, botLevel = 'medium') {
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  const players = [{ id: 'me', name, color: COLORS[3] }];
  for (let i = 0; i < nb; i++) players.push({ id: 'bot' + i, name: names[i] + ' AI', color: COLORS.filter(c => c !== COLORS[3])[i], isBot: true, country: `Republic of ${names[i]}` });
  const engine = new Engine({ players, settings: { spawnTime: 30, startMoney: money, botLevel } });
  show('game');
  const end = () => { clearInterval(state.offlineLoop); state.game.destroy(); state.game = null; show(state.user ? 'home' : 'auth'); };
  state.game = new ClientGame({ root: $('#game'), you: 0, snap: engine.snapshot(), username: name, send: (a) => engine.handle('me', a), onExit: end, offline: true, myId: 'me' });
  let recorded = false;
  state.offlineLoop = setInterval(() => {
    const p = engine.step();
    state.game?.applyPatch(p);
    if (engine.phase === 'over' && !recorded) {
      recorded = true; clearInterval(state.offlineLoop);
      const g = +(store.get('games') || 0) + 1, w = +(store.get('wins') || 0) + (engine.winner === 0 ? 1 : 0);
      store.set('games', g); store.set('wins', w);
    }
  }, TICK_MS);
}

// Phones: ask for full screen + landscape while we still have a tap to do it with.
function requestLandscape() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  try {
    const lock = () => { try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch { /* unsupported */ } };
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(lock, () => {}); else lock();
  } catch { /* not allowed here */ }
}

// ---------------- profiles ----------------
let profileShown = null;
function openProfile(username) {
  profileShown = username;
  $('#profile-modal').classList.remove('hidden');
  if (OFFLINE_ONLY || !state.connected) {
    renderProfile({ username: store.get('offline_name') || 'Commander', av: store.get('avatar') ? 1 : 0, bio: store.get('bio') || '', stats: { games: +(store.get('games') || 0), wins: +(store.get('wins') || 0) }, me: true, offline: true });
  } else { $('#profile-body').innerHTML = '<p class="muted">Loading…</p>'; send({ t: 'profile_get', username }); }
}
function renderProfile(p) {
  if (!p || $('#profile-modal').classList.contains('hidden')) return;
  if (profileShown && p.username.toLowerCase() !== profileShown.toLowerCase() && !p.offline) return;
  const g = p.stats.games || 0, w = p.stats.wins || 0;
  $('#profile-body').innerHTML = `
    <div class="prof-top">${avatarHtml(p.username, p.av, 'xl')}
      <h2>${esc(p.username)}</h2>${p.offline ? '<small>Saved on this device</small>' : `<small><span class="dot ${p.online ? 'on' : ''}"></span>${p.online ? 'Online' : 'Offline'}${p.created ? ' · joined ' + new Date(p.created).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : ''}</small>`}</div>
    ${p.me ? `<div class="photo-row"><button class="btn" id="pf-cam">📷 Camera</button><button class="btn" id="pf-gal">🖼️ Gallery</button>${p.av ? '<button class="btn ghost" id="pf-rm">Remove</button>' : ''}</div>` : ''}
    <div class="prof-stats"><div><b>${g}</b><small>Games</small></div><div><b>${w}</b><small>Wins</small></div><div><b>${g ? Math.round(w / g * 100) : 0}%</b><small>Win rate</small></div>${p.friends !== undefined ? `<div><b>${p.friends}</b><small>Friends</small></div>` : ''}</div>
    ${p.me ? `<label class="field">About me<textarea id="pf-bio" maxlength="160" rows="2" placeholder="Tell other commanders about yourself"></textarea></label><button class="btn primary xl" id="pf-save">Save profile</button>`
      : `<p class="bio"></p><div class="modal-actions">${p.friend ? '<button class="btn ghost" disabled>Friends ✓</button>' : p.pending ? '<button class="btn ghost" disabled>Request sent</button>' : `<button class="btn primary" id="pf-add">${p.incoming ? 'Accept request' : 'Add friend'}</button>`}
         ${p.lobby && p.friend && p.lobby !== state.lobby?.code ? `<button class="btn go" id="pf-join">Join their room</button>` : ''}</div>`}`;
  if (p.me) {
    $('#pf-bio').value = p.bio || '';
    $('#pf-save').onclick = () => { const bio = $('#pf-bio').value; if (p.offline) { store.set('bio', bio); toast('Saved'); } else send({ t: 'profile_update', bio }); };
    $('#pf-cam').onclick = () => takePhoto(p.offline);
    $('#pf-gal').onclick = () => pickFile(false, p.offline);
    const rm = $('#pf-rm'); if (rm) rm.onclick = () => { if (p.offline) { store.set('avatar', null); openProfile(p.username); } else send({ t: 'profile_update', avatar: null }); };
  } else {
    $('.bio', $('#profile-body')).textContent = p.bio || '';
    const add = $('#pf-add'); if (add) add.onclick = () => { send({ t: 'friend_add', username: p.username }); setTimeout(() => send({ t: 'profile_get', username: p.username }), 300); };
    const j = $('#pf-join'); if (j) j.onclick = () => { send({ t: 'lobby_join', code: p.lobby }); $('#profile-modal').classList.add('hidden'); };
  }
}
function saveAvatar(dataUrl, offline) {
  if (offline) { store.set('avatar', dataUrl); renderMe(); openProfile(profileShown); return; }
  send({ t: 'profile_update', avatar: dataUrl });
}
function squareJpeg(source, sw, sh) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const s = Math.min(sw, sh);
  c.getContext('2d').drawImage(source, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, 256, 256);
  return c.toDataURL('image/jpeg', 0.85);
}
function pickFile(camera, offline) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  if (camera) inp.capture = 'user';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const url = URL.createObjectURL(f); const img = new Image();
    img.onload = () => { saveAvatar(squareJpeg(img, img.naturalWidth, img.naturalHeight), offline); URL.revokeObjectURL(url); };
    img.onerror = () => toast('Couldn\'t read that picture.', 'error');
    img.src = url;
  };
  inp.click();
}
async function takePhoto(offline) {
  // Phones: the file picker with capture opens the camera app directly.
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch || !navigator.mediaDevices?.getUserMedia) return pickFile(true, offline);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 640 } }); }
  catch { return pickFile(true, offline); }
  const m = $('#camera-modal'); const v = $('#camera-video'); v.srcObject = stream; m.classList.remove('hidden');
  const stop = () => { stream.getTracks().forEach(t => t.stop()); m.classList.add('hidden'); };
  $('#camera-snap').onclick = () => { saveAvatar(squareJpeg(v, v.videoWidth, v.videoHeight), offline); stop(); };
  $('#camera-cancel').onclick = stop;
}

// ---------------- boot ----------------
function boot() {
  setupAuth(); setupHome(); setupLobby(); setupPractice();
  $('#profile-close').onclick = () => { $('#profile-modal').classList.add('hidden'); profileShown = null; };
  const jm = /^\/join\/([A-Za-z0-9]{4,6})/.exec(location.pathname);
  if (jm) { state.pendingJoin = jm[1].toUpperCase(); history.replaceState(null, '', '/'); }
  show('auth');
  if (OFFLINE_ONLY) { document.body.classList.add('offline'); $('#offline-profile').onclick = () => openProfile(null); }
  connect();
  setConn(OFFLINE_ONLY ? false : state.connected);
}
window.__ww = state; // handy for debugging in the console
boot();

// Client side of a match: holds the view state, draws the map, and turns taps into actions.
import { MAP_W as W, MAP_H as H, getLand } from '../shared/map.js';
import { BUILDINGS, SHIP, CAPITAL, BOMBS, LEVEL_STATS as LS, UPGRADE_MULT, TICK_MS, ECON } from '../shared/rules.js';
import { getRegions } from '../shared/map.js';
import { MapPainter, drawBuilding, drawDot, drawShip, drawBoat, drawMissile } from './render.js';
import { sfx } from './sound.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : Math.floor(n).toLocaleString();
const FALLOUT_TICKS = { bigone: 900, hydrogen: 600, mini: 150, atomic: 350, cluster: 150 };
const BUILD_TYPES = ['city', 'military', 'factory', 'outpost', 'port', 'battery', 'silo', 'radar', 'ship'];
const BOMB_ORDER = Object.keys(BOMBS).sort((a, b) => BOMBS[a].cost - BOMBS[b].cost);
const ICON = { capital: '🏰', military: '🎖️', city: '🏙️', factory: '🏭', port: '⚓', outpost: '🛡️', silo: '🚀', battery: '🎯', radar: '📡', ship: '🚢', atomic: '☢️', hydrogen: '💥', cluster: '🎆', bigone: '🌋', emp: '⚡' };
const SHORT = { military: 'More troops', city: 'More people', factory: 'Most money', outpost: 'Guards land', port: 'Boats + money', battery: 'Shoots missiles', silo: 'Launch bombs', radar: 'Better batteries', ship: 'Navy', atomic: 'Medium blast', cluster: 'Splits in 8', hydrogen: 'Huge blast', bigone: 'Biggest bomb', emp: 'Shuts buildings' };
const SVG = {
  trophy: '<svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
};

const ACTION_SFX = { attack: () => sfx.march(), give: () => sfx.march(), build: () => sfx.build(), upgrade: () => sfx.build(), ally: () => sfx.tap() };

export class ClientGame {
  constructor({ root, you, snap, username, send, onExit, onChat, offline, myId }) {
    this.myId = myId; this.root = root; this.you = you; this.username = username;
    this.send = (a) => { const s = ACTION_SFX[a.type]; if (s) s(); send(a); }; this.onExit = onExit; this.offline = offline; this.onChatCb = onChat;
    this.land = getLand();
    this.landCount = this.land.reduce((a, b) => a + b, 0);
    this.owner = new Int16Array(W * H).fill(-1);
    this.painter = new MapPainter();
    this.regions = getRegions(); this.regHolder = snap.rh || []; this.settings = snap.settings || {};
    this.info = snap.pi; this.painter.setPlayers(this.info);
    for (let k = 0; k < snap.own.length; k += 2) this.owner[snap.own[k]] = snap.own[k + 1];
    for (let k = 0; k < snap.fo.length; k += 2) this.painter.fallout.set(snap.fo[k], snap.fo[k + 1]);
    this.painter.setOwner(this.owner);
    this.supply = new Uint8Array(W * H);
    this.supplyCanvas = document.createElement('canvas'); this.supplyCanvas.width = W; this.supplyCanvas.height = H;
    this.buildings = []; this.setBuildings(snap.bl);
    this.stats = []; this.boats = []; this.ships = []; this.missiles = []; this.attacks = [];
    this.phase = snap.phase; this.tick = snap.tick; this.spawnLeft = 0;
    this.effects = []; this.shake = 0;
    this.mode = { kind: 'attack' }; this.ratio = 0.3; this.selected = null;
    this.prev = { ms: new Map(), boats: new Map(), ships: new Map() }; this.lastPatchAt = performance.now();
    this.named = false; this.supplyHintAt = 0; this.toastSeen = new Map();
    this.setDiplomacy(snap.dip || { al: [], rq: [] });
    this.buildDom();
    this.canvas = $('canvas', this.root); this.ctx = this.canvas.getContext('2d');
    this.cam = { x: W / 2, y: H / 2, s: 2 };
    this.resize(); this.fitWorld();
    this.bindInput();
    this.running = true; requestAnimationFrame(() => this.frame());
    this._resize = () => this.resize(); window.addEventListener('resize', this._resize);
  }

  destroy() {
    this.running = false; window.removeEventListener('resize', this._resize); window.removeEventListener('keydown', this._key);
    this.root.innerHTML = '';
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* not in fullscreen */ }
  }

  // ---------- DOM ----------
  buildDom() {
    this.root.innerHTML = `
    <canvas class="map"></canvas>
    <div class="hud hud-tl">
      <div class="statusbar glass">
        <span class="flag"></span><span class="sb-name"><b class="n-name"></b><small class="n-sub"></small></span>
        <i class="sep"></i>
        <span class="sb-stat" title="People"><em>👥</em><span><b class="s-troops">0</b><span class="bar"><i class="s-bar"></i></span></span></span>
        <i class="sep"></i>
        <span class="sb-stat money" title="Money"><em>💰</em><span><b class="s-money">0</b><small class="s-inc"></small></span></span>
      </div>
    </div>
    <div class="hud hud-tr">
      <button class="icon-btn b-lb" title="Countries and alliances" aria-label="Countries and alliances">${SVG.flag}</button>
      <button class="icon-btn b-chat" title="Chat" aria-label="Chat">${SVG.chat}</button>
      <button class="icon-btn b-menu" title="Menu" aria-label="Menu">${SVG.menu}</button>
    </div>
    <div class="hud banner spawn hidden"></div>
    <div class="hud alarm hidden"><span class="al-text"></span><button class="btn small al-btn">Fight back</button></div>
    <div class="hud offers"></div>
    <div class="hud side-panel glass leaderboard hidden"></div>
    <div class="hud side-panel glass chat-panel hidden"><h4>Chat</h4><div class="chat-log"></div><form class="chat-form"><input maxlength="200" placeholder="Say something" aria-label="Chat message"><button class="btn small primary">Send</button></form>
      <div class="emotes">${['😂', '😡', '🤝', '💀', '👋', 'gg'].map(e => `<button type="button" data-e="${e}">${e}</button>`).join('')}</div></div>
    <div class="hud feed"></div>
    <div class="hud mode-pill hidden"><span></span><button class="btn small primary">Done</button></div>
    <div class="hud inspector glass hidden"></div>
    <div class="hud hud-bl">
      <div class="sender glass" role="group" aria-label="How many people to send">
        <span class="sender-label">Send<b class="ratio-n"></b></span>
        <div class="quick">${[10, 25, 50, 75, 100].map(v => `<button data-q="${v}">${v}%</button>`).join('')}</div>
      </div>
    </div>
    <div class="hud hud-br">
      <button class="dock-btn b-build" aria-label="Build"><span class="di">🏗️</span><span>Build</span></button>
      <button class="dock-btn bombs b-bomb" aria-label="Bombs"><span class="di">🚀</span><span>Bombs</span></button>
    </div>
    <div class="hud strip glass hidden"></div>
    <div class="modal-wrap hidden name-modal"><div class="modal"><div class="prof-top"><span class="flag-big"></span><h2>Name your country</h2><p class="muted">Everyone will see this on the map.</p></div>
      <input class="country-in" maxlength="32" aria-label="Country name"><div class="modal-actions"><button class="btn ghost b-name-no">No thanks</button><button class="btn primary b-name-ok">Start here</button></div></div></div>
    <div class="modal-wrap hidden menu-modal"><div class="modal"><h2>Paused?</h2><p class="muted">The war keeps going while this is open.</p>
      <button class="btn xl b-close">Back to the map</button><button class="btn ghost xl b-help">How to play</button><button class="btn ghost xl b-rename">Rename country</button><button class="btn ghost xl b-sound"></button><button class="btn ghost xl b-leave">Leave game</button><button class="btn danger xl b-surrender">Surrender</button></div></div>
    <div class="modal-wrap hidden help-modal"><div class="modal"><h2>How to play</h2><div class="help-list">
      <div><span class="ci">👆</span><p><b>Expand</b>Tap empty land next to you. The slider sets how many people go. More people means a faster push.</p></div>
      <div><span class="ci">🏰</span><p><b>Supply range</b>Land near your capital, cities, outposts and ports is quick and cheap to take. Past that it costs 3 times as many people. Build at your edges to keep growing.</p></div>
      <div><span class="ci">⚔️</span><p><b>Invade and defend</b>Tap a neighbour to invade. When someone invades you, hit Fight back. Counter-attacks hit harder and move faster, and land you just lost is cheap to take back. Lose your capital and half your people scatter.</p></div>
      <div><span class="ci">🤝</span><p><b>Alliances</b>Open the flag panel to ask a country to be allies. Allies can't invade or shell each other, and tapping an ally's land sends them people. You can betray an ally, but they'll fight harder against you for a while.</p></div>
      <div><span class="ci">⛵</span><p><b>Islands</b>Tap land across the water and a boat sails your troops there. Ports make boats faster.</p></div>
      <div><span class="ci">🏙️</span><p><b>Buildings</b>Cities add people, factories add the most money, outposts guard the land around them (tap an enemy outpost to charge straight at it, then its land is easy). Tap a building to upgrade it to level 3.</p></div>
      <div><span class="ci">🚀</span><p><b>Bombs</b>Build a Missile Silo, then use Bombs. Batteries shoot missiles down and radars make them better.</p></div>
      <div><span class="ci">⭐</span><p><b>Hold countries</b>Thin outlines on the map are real countries. Own every bit of one to earn extra money and faster troop growth for as long as you hold it. Bigger countries pay more.</p></div>
      <div><span class="ci">🏆</span><p><b>Win</b>Own the target share of the world's land, or be the last country standing. If everyone left is allied and together owns enough land, the alliance wins. In Full World Takeover you must own all of it.</p></div>
      </div><button class="btn primary xl b-help-close">Got it</button></div></div>
    <div class="modal-wrap hidden give-modal"><div class="modal"><div class="prof-top"><span class="flag-big give-flag"></span><h2 class="give-title">Send people?</h2><p class="muted give-sub"></p></div>
      <div class="give-ratios"></div>
      <div class="modal-actions"><button class="btn ghost b-give-no">Cancel</button><button class="btn go b-give-ok">Send</button></div></div></div>
    <div class="modal-wrap hidden over-modal"><div class="modal over"></div></div>
    <div class="rotate"><div class="phone"></div><h2>Turn your phone sideways</h2><p>The map needs the room. Rotate to landscape to play.</p><button class="btn primary b-rot">Go full screen</button></div>`;
    const r = this.root;
    const setRatio = (v) => { this.ratio = v / 100; for (const b of r.querySelectorAll('.quick button')) b.classList.toggle('on', +b.dataset.q === +v); this.updateHud(); };
    for (const b of r.querySelectorAll('.quick button')) b.onclick = () => setRatio(+b.dataset.q);
    setRatio(25);
    $('.b-build', r).onclick = () => this.openStrip('build');
    $('.b-bomb', r).onclick = () => this.openStrip('bomb');
    $('.b-lb', r).onclick = () => this.togglePanel('leaderboard');
    $('.b-chat', r).onclick = () => { this.togglePanel('chat-panel'); $('.b-chat', r).querySelector('.dot-badge')?.remove(); };
    $('.b-menu', r).onclick = () => $('.menu-modal', r).classList.remove('hidden');
    $('.b-close', r).onclick = () => $('.menu-modal', r).classList.add('hidden');
    $('.b-help', r).onclick = () => { $('.menu-modal', r).classList.add('hidden'); $('.help-modal', r).classList.remove('hidden'); };
    $('.b-help-close', r).onclick = () => $('.help-modal', r).classList.add('hidden');
    $('.b-surrender', r).onclick = (e) => {
      const btn = e.currentTarget;
      if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Tap again to surrender'; setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Surrender'; }, 3000); return; }
      this.send({ type: 'surrender' }); $('.menu-modal', r).classList.add('hidden');
    };
    $('.b-leave', r).onclick = () => this.onExit();
    const sb = $('.b-sound', r), sl = () => { sb.textContent = sfx.on ? '🔊 Sound: on' : '🔇 Sound: off'; }; sl();
    sb.onclick = () => { sfx.toggle(); sl(); };
    $('.b-rename', r).onclick = () => { $('.menu-modal', r).classList.add('hidden'); this.askName(null); };
    $('.mode-pill button', r).onclick = () => this.setMode({ kind: 'attack' });
    $('.b-name-ok', r).onclick = () => this.confirmName(false);
    $('.b-name-no', r).onclick = () => this.confirmName(true);
    $('.country-in', r).onkeydown = (e) => { if (e.key === 'Enter') this.confirmName(false); };
    $('.chat-form', r).onsubmit = (e) => { e.preventDefault(); const i = $('input', e.target); if (i.value.trim()) this.onChatCb?.(i.value.trim()); i.value = ''; };
    for (const b of r.querySelectorAll('.emotes button')) b.onclick = () => this.onChatCb?.(b.dataset.e);
    $('.al-btn', r).onclick = () => this.fightBack();
    $('.b-rot', r).onclick = () => this.goLandscape();
    if (this.offline) $('.b-chat', r).style.display = 'none';
  }

  togglePanel(cls) {
    for (const p of this.root.querySelectorAll('.side-panel')) { const on = p.classList.contains(cls) && p.classList.contains('hidden'); p.classList.toggle('hidden', !on); }
    $('.b-lb', this.root).classList.toggle('on', !$('.leaderboard', this.root).classList.contains('hidden'));
    $('.b-chat', this.root).classList.toggle('on', !$('.chat-panel', this.root).classList.contains('hidden'));
    this.updateHud();
  }

  goLandscape() {
    const el = document.documentElement;
    const lock = () => { try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch { /* unsupported */ } };
    try {
      if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(lock, () => {});
      else lock();
    } catch { /* fullscreen not allowed here */ }
  }

  me() { return this.stats[this.you]; }

  openStrip(kind) {
    const strip = $('.strip', this.root);
    const open = strip.classList.contains('hidden') || strip.dataset.kind !== kind;
    strip.classList.toggle('hidden', !open); strip.dataset.kind = kind;
    $('.b-build', this.root).classList.toggle('on', open && kind === 'build');
    $('.b-bomb', this.root).classList.toggle('on', open && kind === 'bomb');
    if (open) { this.select(null); strip._html = ''; this.renderStrip(); }
  }
  closeStrip() { $('.strip', this.root).classList.add('hidden'); $('.b-build', this.root).classList.remove('on'); $('.b-bomb', this.root).classList.remove('on'); }
  renderStrip() {
    const strip = $('.strip', this.root); if (strip.classList.contains('hidden')) return;
    const money = this.me()?.money || 0;
    const silo = Math.max(0, ...this.buildings.filter(b => b.owner === this.you && b.type === 'silo').map(b => b.level));
    let html = '';
    if (strip.dataset.kind === 'build') {
      // cheapest first, using what each one costs you right now
      const items = BUILD_TYPES.map(t => {
        const def = t === 'ship' ? SHIP : BUILDINGS[t];
        const count = t === 'ship' ? this.ships.filter(s => s.o === this.you).length : this.buildings.filter(b => b.owner === this.you && b.type === t).length;
        return { t, def, cost: Math.round(def.cost * (1 + 0.3 * count)) };
      }).sort((a, b) => a.cost - b.cost || a.def.cost - b.def.cost);
      html = items.map(({ t, def, cost }) => {
        return `<button class="card-btn ${money < cost ? 'poor' : ''}" data-b="${t}"><span class="ci">${ICON[t]}</span><b>${def.name.replace('Missile ', '')}</b><span>$${fmt(cost)}</span><small>${SHORT[t]}</small></button>`;
      }).join('');
    } else {
      html = BOMB_ORDER.map(t => {
        const d = BOMBS[t]; const locked = silo < d.silo;
        return `<button class="card-btn ${money < d.cost ? 'poor' : ''} ${locked ? 'locked' : ''}" data-m="${t}"><span class="ci">${ICON[t]}</span><b>${d.name}</b><span>$${fmt(d.cost)}</span><small>${locked ? (silo ? `Silo level ${d.silo}` : 'Needs a silo') : SHORT[t]}</small></button>`;
      }).join('');
    }
    if (strip._html !== html) {
      const sl = strip.scrollLeft; strip.innerHTML = html; strip._html = html; strip.scrollLeft = sl;
      for (const b of strip.querySelectorAll('[data-b]')) b.onclick = () => { this.setMode({ kind: 'build', what: b.dataset.b }); this.closeStrip(); };
      for (const b of strip.querySelectorAll('[data-m]')) b.onclick = () => {
        if (b.classList.contains('locked')) return this.toast(silo ? `${BOMBS[b.dataset.m].name} needs a level ${BOMBS[b.dataset.m].silo} silo. Tap your silo to upgrade it.` : 'Build a Missile Silo first.', 'error');
        this.setMode({ kind: 'bomb', what: b.dataset.m }); this.closeStrip();
      };
    }
  }
  setMode(m) {
    this.mode = m;
    const pill = $('.mode-pill', this.root);
    if (m.kind === 'attack') { pill.classList.add('hidden'); return; }
    let label = '';
    if (m.kind === 'build') label = m.what === 'ship' ? `${ICON.ship} Tap near one of your ports` : `${ICON[m.what]} Tap your land to place a ${BUILDINGS[m.what].name}`;
    if (m.kind === 'bomb') label = `${ICON[m.what]} Tap a target for the ${BOMBS[m.what].name}`;
    if (m.kind === 'ship') label = `${ICON.ship} Tap the water to sail there`;
    $('span', pill).textContent = label; $('button', pill).textContent = 'Cancel'; pill.classList.remove('hidden');
  }

  askName(tile) {
    this.pendingSpawn = tile;
    const inp = $('.country-in', this.root);
    const cur = this.info[this.you]?.country;
    inp.value = this.named && cur ? cur : ''; inp.placeholder = `${this.username}'s Country`;
    const f = $('.flag-big', this.root); f.style.cssText = `width:64px;height:64px;border-radius:20px;background:${this.info[this.you]?.color};box-shadow:inset 0 -6px 0 rgba(0,0,0,.2)`;
    $('.name-modal', this.root).classList.remove('hidden');
    setTimeout(() => inp.focus(), 60);
  }
  confirmName(skip) {
    const v = skip ? `${this.username}'s Country` : ($('.country-in', this.root).value.trim() || `${this.username}'s Country`);
    $('.name-modal', this.root).classList.add('hidden');
    this.named = true;
    if (this.pendingSpawn !== null && this.pendingSpawn !== undefined && this.phase === 'spawn') this.send({ type: 'spawn', tile: this.pendingSpawn, country: v });
    else this.send({ type: 'rename', country: v });
    this.pendingSpawn = null;
  }

  toast(text, kind = 'info') {
    const feed = $('.feed', this.root), now = performance.now();
    // the same note at most once every 8 seconds, and never two of the same on screen
    if (now - (this.toastSeen.get(text) || -1e9) < 8000) return;
    this.toastSeen.set(text, now); if (this.toastSeen.size > 200) this.toastSeen.clear();
    // only one toast at a time on small screens, two on bigger ones
    const max = this.vh < 500 ? 1 : 2;
    const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = text;
    feed.prepend(el); while (feed.children.length > max) feed.lastChild.remove();
    const life = kind === 'error' ? 2600 : 3200;
    setTimeout(() => el.classList.add('fade'), life); setTimeout(() => el.remove(), life + 500);
  }
  chat(entry) {
    const log = $('.chat-panel .chat-log', this.root);
    const el = document.createElement('div'); el.innerHTML = '<b></b> <span></span>'; el.querySelector('b').textContent = entry.from + ':'; el.querySelector('span').textContent = entry.text;
    log.append(el); log.scrollTop = 1e9;
    if ($('.chat-panel', this.root).classList.contains('hidden')) {
      const btn = $('.b-chat', this.root); if (!btn.querySelector('.dot-badge')) btn.insertAdjacentHTML('beforeend', '<i class="dot-badge"></i>');
      this.toast(`${entry.from}: ${entry.text}`, 'chat');
    }
  }

  // ---------- state ----------
  setBuildings(bl) {
    this.buildings = bl;
    // supply mask for my own country (same rule as the server)
    this.supply.fill(0); this.supplySources = [];
    for (const b of bl) {
      if (b.owner !== this.you || b.dis) continue;
      const r = b.type === 'capital' ? CAPITAL.supply : LS[b.type]?.supply?.[b.level]; if (!r) continue;
      this.supplySources.push({ x: b.x + 0.5, y: b.y + 0.5, r: r + 0.5 });
      const R = Math.ceil(r);
      for (let dy = -R; dy <= R; dy++) { const y = b.y + dy; if (y < 0 || y >= H) continue;
        for (let dx = -R; dx <= R; dx++) { const x = b.x + dx; if (x < 0 || x >= W || dx * dx + dy * dy > r * r) continue; this.supply[y * W + x] = 1; } }
    }
    const ctx = this.supplyCanvas.getContext('2d'), img = ctx.createImageData(W, H), d = new Uint32Array(img.data.buffer);
    for (let i = 0; i < W * H; i++) {
      if (!this.supply[i]) continue; const x = i % W;
      const edge = (x > 0 && !this.supply[i - 1]) || (x < W - 1 && !this.supply[i + 1]) || (i >= W && !this.supply[i - W]) || (i < W * H - W && !this.supply[i + W]);
      if (!edge && this.land[i]) d[i] = 0x10ffffff;
    }
    ctx.putImageData(img, 0, 0);
  }

  setDiplomacy(d) {
    this.allies = new Set(); this.sentReq = new Set(); this.gotReq = new Set();
    for (const [a, b] of d.al) { if (a === this.you) this.allies.add(b); else if (b === this.you) this.allies.add(a); }
    for (const [f, t] of d.rq) { if (f === this.you) this.sentReq.add(t); else if (t === this.you) this.gotReq.add(f); }
    this.painter.setAllies(this.allies, this.owner);
    this.renderOffers();
  }
  isAlly(i) { return this.allies?.has(i); }
  // sending people to an ally always asks first, with the amount spelled out
  askGive(to) {
    const m = $('.give-modal', this.root), inf = this.info[to]; if (!inf) return;
    let ratio = this.ratio;
    const draw = () => {
      const n = Math.floor((this.me()?.troops || 0) * ratio);
      $('.give-flag', m).style.background = inf.color;
      $('.give-title', m).textContent = `Send ${fmt(n)} people?`;
      $('.give-sub', m).textContent = `They'll leave your country and join your ally ${inf.country}. You can't take them back.`;
      $('.give-ratios', m).innerHTML = [0.1, 0.25, 0.5, 0.75, 1].map(r => `<button class="chip ${Math.abs(r - ratio) < 0.001 ? 'on' : ''}" data-r="${r}">${Math.round(r * 100)}%</button>`).join('');
      for (const b of m.querySelectorAll('[data-r]')) b.onclick = () => { ratio = +b.dataset.r; draw(); };
    };
    draw();
    const tick = setInterval(() => { if (m.classList.contains('hidden') || !this.isAlly(to)) { clearInterval(tick); m.classList.add('hidden'); } else draw(); }, 500);
    $('.b-give-no', m).onclick = () => m.classList.add('hidden');
    $('.b-give-ok', m).onclick = () => { m.classList.add('hidden'); this.send({ type: 'give', to, ratio }); };
    m.classList.remove('hidden');
  }
  renderOffers() {
    const box = $('.offers', this.root); if (!box) return;
    const key = [...this.gotReq].join(',');
    if (box._key === key) return; if (this.gotReq.size && key.length > (box._key || '').length) sfx.chime(); box._key = key;
    box.innerHTML = [...this.gotReq].slice(0, 2).map(f => `<div class="offer glass"><i style="background:${this.info[f]?.color}"></i><span><b></b> wants to be allies</span><button class="btn small ghost" data-no="${f}">No</button><button class="btn small go" data-yes="${f}">Ally</button></div>`).join('');
    box.querySelectorAll('.offer b').forEach((b, k) => { b.textContent = this.info[[...this.gotReq][k]]?.country || ''; });
    for (const b of box.querySelectorAll('[data-yes]')) b.onclick = () => this.send({ type: 'allyAnswer', from: +b.dataset.yes, yes: true });
    for (const b of box.querySelectorAll('[data-no]')) b.onclick = () => this.send({ type: 'allyAnswer', from: +b.dataset.no, yes: false });
  }
  applyPatch(p) {
    const dt = p.tick - this.tick; this.tick = p.tick;
    if (p.pi) { this.info = p.pi; this.painter.setPlayers(this.info); this.painter.setOwner(this.owner); }
    if (p.dip) { this.setDiplomacy(p.dip); this.lbKey = ''; }
    if (p.rh) { this.regHolder = p.rh; this.lbKey = ''; }
    const ch = p.ch;
    let gained = 0, took = 0;
    for (let k = 0; k < ch.length; k += 2) { if (ch[k + 1] === this.you && this.owner[ch[k]] !== this.you) { gained++; if (this.owner[ch[k]] >= 0) took++; } this.owner[ch[k]] = ch[k + 1]; }
    if (gained && this.phase === 'play') sfx.expand(gained, took > 0);
    for (let k = 0; k < ch.length; k += 2) this.painter.repaintAround(ch[k]);
    if (this.painter.fallout.size && dt > 0) {
      for (const [i, t] of this.painter.fallout) { if (t <= dt) { this.painter.fallout.delete(i); this.painter.paint(i); } else this.painter.fallout.set(i, t - dt); }
    }
    this.stats = p.ps;
    if (p.bl) { this.setBuildings(p.bl); if (this.selected && this.selected.kind === 'b' && !this.buildings.find(b => b.id === this.selected.id)) this.select(null); }
    this.prev = { ms: new Map(this.missiles.map(m => [m.id, m])), boats: new Map(this.boats.map(b => [b.id, b])), ships: new Map(this.ships.map(s => [s.id, s])) };
    for (const m of p.ms) if (!this.prev.ms.has(m.id) && m.type !== 'mini') sfx.launch();
    for (const b of p.boats) if (!this.prev.boats.has(b.id) && b.o === this.you) sfx.sail();
    this.boats = p.boats; this.ships = p.ships; this.attacks = p.atk; this.missiles = p.ms; this.lastPatchAt = performance.now();
    if (this.selected && this.selected.kind === 's' && !this.ships.find(s => s.id === this.selected.id)) { this.select(null); if (this.mode.kind === 'ship') this.setMode({ kind: 'attack' }); }
    const prevPhase = this.phase; this.phase = p.phase; this.spawnLeft = p.spawnLeft;
    if (prevPhase === 'spawn' && p.phase === 'play') {
      this.named = true; $('.name-modal', this.root).classList.add('hidden');
      const me = this.me(); if (me && me.cx >= 0) this.flyTo(me.cx, me.cy, Math.max(this.cam.s, Math.min(this.vw, this.vh) / 60));
    }
    for (const e of p.ev) this.onEvent(e);
    this.updateHud();
  }
  // troops a country has out fighting (attacks and boats), which are not at home defending
  awayOf(i) { let n = 0; for (const a of this.attacks) if (a.a === i && a.t >= 0) n += a.n; for (const b of this.boats) if (b.o === i) n += b.n; return n; }
  // armies marching from the heart of a country to its front line, with a count badge at the front
  drawArmies(ctx, px, now) {
    for (const a of this.attacks) {
      if (a.t < 0 || a.x === undefined || a.n < 1) continue;
      const st = this.stats[a.a], inf = this.info[a.a]; if (!st || st.cx < 0 || !inf) continue;
      const mine = a.a === this.you || a.t === this.you;
      const x1 = st.cx + 0.5, y1 = st.cy + 0.5, x2 = a.x + 0.5, y2 = a.y + 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1);
      ctx.globalAlpha = mine ? 1 : 0.55;
      if (len > 3) {
        const gap = Math.max(10 * px, len / 14), off = ((now / 900) * 30 * px) % gap, r = (mine ? 3.2 : 2.4) * px;
        ctx.fillStyle = inf.color; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2 * px;
        for (let d = off; d < len; d += gap) {
          const q = d / len, x = x1 + (x2 - x1) * q, y = y1 + (y2 - y1) * q;
          ctx.beginPath(); ctx.arc(x, y, r * (0.6 + 0.4 * q), 0, 7); ctx.fill(); ctx.stroke();
        }
      }
      const label = '⚔️ ' + fmt(a.n); ctx.font = `900 ${(mine ? 12 : 10) * px}px Nunito, system-ui`;
      const tw = ctx.measureText(label).width + 12 * px, h = (mine ? 18 : 15) * px;
      ctx.fillStyle = inf.color; ctx.strokeStyle = a.t === this.you ? '#ff4d6d' : 'rgba(255,255,255,0.9)'; ctx.lineWidth = (a.t === this.you ? 2.5 : 1.5) * px;
      ctx.beginPath(); ctx.roundRect(x2 - tw / 2, y2 - h / 2, tw, h, h / 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2.5 * px; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeText(label, x2, y2 + px * 0.5); ctx.fillText(label, x2, y2 + px * 0.5);
      ctx.globalAlpha = 1;
    }
  }
  flyTo(x, y, s) { this.fly = { x0: this.cam.x, y0: this.cam.y, s0: this.cam.s, x, y, s: s || this.cam.s, t0: performance.now() }; }

  onEvent(e) {
    if (e.to && this.myId && e.to !== this.myId) return;
    const now = performance.now();
    if (e.k === 'msg' && /war has begun/.test(e.text) && this.settings?.mode === 'takeover') e = { ...e, text: 'Full World Takeover! You win only by owning every bit of land.' };
    if (e.k === 'msg') { this.toast(e.text, e.kind); if (e.kind === 'good') sfx.good(); else if (e.kind === 'error') sfx.bad(); }
    else if (e.k === 'boom') {
      this.effects.push({ k: 'boom', x: e.x + 0.5, y: e.y + 0.5, r: e.r, type: e.type, t0: now, dur: e.type === 'bigone' ? 3200 : e.r > 5 ? 1800 : 700 });
      if (e.r >= 5) this.shake = Math.max(this.shake, e.type === 'bigone' ? 22 : e.r);
      sfx.boom(e.r, e.type === 'bigone');
      if (e.type === 'bld') {
        sfx.crumble(e.cap);
        if (e.cap) this.shake = Math.max(this.shake, 9);
        const bits = [];
        for (let k = 0; k < (e.cap ? 22 : 12); k++) { const a = Math.random() * Math.PI * 2, v = (0.6 + Math.random()) * (e.cap ? 3.2 : 2); bits.push({ dx: Math.cos(a) * v, dy: Math.sin(a) * v, s: 0.5 + Math.random() }); }
        this.effects.push({ k: 'debris', x: e.x + 0.5, y: e.y + 0.5, bits, t0: now, dur: e.cap ? 1600 : 1100 });
        this.effects.push({ k: 'smoke', x: e.x + 0.5, y: e.y + 0.5, r: e.cap ? 5 : 3, t0: now, dur: e.cap ? 3500 : 2400 });
      }
      if (e.type === 'bigone') this.effects.push({ k: 'flash', t0: now, dur: 900 });
      if (FALLOUT_TICKS[e.type]) {
        const R = Math.ceil(e.r);
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > e.r * e.r) continue; const x = e.x + dx, y = e.y + dy; if (x < 0 || x >= W || y < 0 || y >= H) continue;
          const i = y * W + x; if (this.land[i]) { this.painter.fallout.set(i, FALLOUT_TICKS[e.type]); this.painter.paint(i); }
        }
      }
    } else if (e.k === 'shot') { sfx.shot(); this.effects.push({ k: 'line', x1: e.x1 + 0.5, y1: e.y1 + 0.5, x2: e.x2 + 0.5, y2: e.y2 + 0.5, t0: now, dur: 300, c: '#ffdd55' }); }
    else if (e.k === 'icpt') { sfx.zap(e.hit); this.effects.push({ k: 'line', x1: e.bx + 0.5, y1: e.by + 0.5, x2: e.x + 0.5, y2: e.y + 0.5, t0: now, dur: 400, c: e.hit ? '#7cf' : 'rgba(150,200,255,0.5)' }); }
    else if (e.k === 'over') this.showOver(e);
    else if (e.k === 'give') { if (e.t === this.you || e.a === this.you) sfx.give(); const a = this.stats[e.a], b = this.stats[e.t]; if (a && b && a.cx >= 0 && b.cx >= 0) this.effects.push({ k: 'give', x1: a.cx + 0.5, y1: a.cy + 0.5, x2: b.cx + 0.5, y2: b.cy + 0.5, c: this.info[e.a]?.color || '#fff', t0: now, dur: 1400 }); }
    else if (e.k === 'betray' && (e.t === this.you)) { this.shake = Math.max(this.shake, 6); sfx.betray(); }
  }
  showOver(e) {
    const win = this.info[e.winner]; const meWon = e.winner === this.you;
    const box = $('.over', this.root);
    const inTeam = !meWon && e.team?.includes(this.you);
    if (meWon || inTeam) sfx.win(); else sfx.lose();
    box.innerHTML = `<div class="over-hero"><span class="big">${meWon ? '🏆' : inTeam ? '🤝' : '🏳️'}</span><h2>${meWon ? 'You conquered the world!' : inTeam ? 'Your alliance won!' : 'Game over'}</h2><p class="muted winner"></p></div>
      <div style="overflow-x:auto"><table><tr><th>#</th><th>Country</th><th>Peak land</th><th>Bombed</th><th>Bombs</th></tr>
      ${e.ranking.map((r, i) => `<tr class="${r.idx === this.you ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:${this.info[r.idx].color}"></i>${esc(r.country)}</td><td>${r.peak}</td><td>${r.kills}</td><td>${r.bombs}</td></tr>`).join('')}</table></div>
      ${e.team && e.team.length > 1 ? `<p class="muted center">Alliance victory: ${e.team.map(i => esc(this.info[i].country)).join(', ')}</p>` : ''}
      <button class="btn primary xl b-over">Back to menu</button><button class="btn ghost xl b-over-stay">Look at the map</button>`;
    $('.winner', box).textContent = `${win.country} (${win.name}) won.`;
    $('.b-over', box).onclick = () => this.onExit();
    $('.b-over-stay', box).onclick = () => { $('.over-modal', this.root).classList.add('hidden'); const lb = $('.b-menu', this.root); lb.onclick = () => this.onExit(); lb.innerHTML = SVG.x; };
    $('.over-modal', this.root).classList.remove('hidden');
  }

  updateHud() {
    const r = this.root, me = this.me(), info = this.info[this.you];
    if (me && info) {
      $('.flag', r).style.background = info.color;
      $('.n-name', r).textContent = info.country;
      $('.n-sub', r).textContent = me.alive ? `${(me.tiles / this.landCount * 100).toFixed(1)}% of the world` : 'Fallen';
      const away = this.awayOf(this.you);
      $('.s-troops', r).textContent = away ? `${fmt(me.troops)} · ⚔️${fmt(away)}` : fmt(me.troops);
      $('.s-bar', r).style.width = Math.min(100, me.troops / Math.max(1, me.max) * 100) + '%';
      $('.s-money', r).textContent = '$' + fmt(me.money); $('.s-inc', r).textContent = `+${fmt(me.inc)}/s`;
      $('.ratio-n', r).textContent = fmt(me.troops * this.ratio);
    }
    const banner = $('.banner', r);
    if (this.phase === 'spawn') {
      banner.classList.remove('hidden');
      banner.textContent = me && me.tiles ? `Starting in ${this.spawnLeft}s · tap again to move` : `Tap the map to pick your start · ${this.spawnLeft}s`;
    } else banner.classList.add('hidden');
    // invasion alarm
    const alarm = $('.alarm', r);
    // one calm line for every attack on you: the biggest attacker, plus how many others
    const all = this.attacks.filter(a => a.t === this.you && a.a !== this.you && !this.info[a.a]?.tribe).sort((a, b) => b.n - a.n);
    const tribeHits = this.attacks.filter(a => a.t === this.you && this.info[a.a]?.tribe);
    const incoming = all[0] || tribeHits[0];
    const missiles = this.missiles.filter(m => m.o !== this.you && m.type !== 'mini' && this.owner[Math.round(m.ty) * W + Math.round(m.tx)] === this.you);
    if (this.phase === 'play' && (incoming || missiles.length) && this.mode.kind === 'attack') {
      alarm.classList.remove('hidden'); alarm.classList.toggle('missile', !!missiles.length);
      if (missiles.length) sfx.siren(); else sfx.alarm();
      this.incoming = incoming;
      let text;
      if (missiles.length) text = `☢️ ${missiles.length > 1 ? missiles.length + ' missiles' : 'Missile'} incoming from ${this.info[missiles[0].o].country}`;
      else {
        const total = all.concat(tribeHits).reduce((s, a) => s + a.n, 0), others = all.length + tribeHits.length - 1;
        text = `⚔️ ${this.info[incoming.a].country}${others > 0 ? ` +${others}` : ''} · ${fmt(total)} invading`;
      }
      const t = $('.al-text', alarm); if (t.textContent !== text) t.textContent = text;
      $('.al-btn', alarm).classList.toggle('hidden', !incoming);
    } else alarm.classList.add('hidden');
    // leaderboard
    const lb = $('.leaderboard', r);
    if (!lb.classList.contains('hidden')) this.renderCountries(lb);
    this.renderStrip();
    if (this.selected) this.renderInspector();
  }

  // real-world countries you hold, plus the closest ones to finish
  heldHtml() {
    const R = this.regions.list, mine = [];
    for (let r = 0; r < R.length; r++) if (this.regHolder[r] === this.you) mine.push(R[r]);
    const near = [];
    if (this.me()?.alive) {
      const have = new Int32Array(R.length), id = this.regions.id;
      for (let t = 0; t < id.length; t++) if (id[t] >= 0 && this.owner[t] === this.you) have[id[t]]++;
      for (let r = 0; r < R.length; r++) if (this.regHolder[r] !== this.you && have[r] > 0) near.push({ R: R[r], p: have[r] / R[r].size });
      near.sort((a, b) => b.p - a.p);
    }
    const bonus = mine.reduce((s, x) => s + x.bonus, 0);
    let h = `<h4>Countries you hold</h4>`;
    h += mine.length ? `<p class="lb-tip">${mine.map(x => `⭐ ${esc(x.name)}`).join(' · ')}<br><b>+$${bonus * ECON.regionMoney}/s</b> and <b>+${Math.round(Math.min(ECON.regionGrowthMax, bonus * ECON.regionGrowth) * 100)}%</b> troop growth</p>`
      : '<p class="lb-tip">Take every bit of a real country (the thin outlines on the map) to earn money and troops while you hold it.</p>';
    if (near.length) h += `<p class="lb-tip">Almost there: ${near.slice(0, 3).map(x => `${esc(x.R.name)} ${Math.floor(x.p * 100)}%`).join(' · ')}</p>`;
    return h;
  }

  // Countries panel: ranking plus alliance actions
  renderCountries(lb) {
    const rows = this.stats.map((s, i) => ({ s, i })).filter(o => o.s.alive && !this.info[o.i]?.tribe).sort((a, b) => Math.round(b.s.tiles / 50) - Math.round(a.s.tiles / 50) || a.i - b.i);
    const live = this.phase === 'play' && this.me()?.alive;
    const pct = (o) => (o.s.tiles / this.landCount * 100).toFixed(1) + '%';
    // rebuild only when the order or alliances change, so buttons stay put under your finger
    const key = rows.map(o => o.i).join('|') + '/' + this.regHolder.join() + '/' + [...this.allies].join() + '/' + [...this.sentReq].join() + '/' + [...this.gotReq].join() + live;
    if (lb._key === key && this.lbKey !== '') { rows.forEach((o) => { const el = lb.querySelector(`[data-pct="${o.i}"]`); if (el && el.textContent !== pct(o)) el.textContent = pct(o); }); return; }
    lb._key = key; this.lbKey = key;
    const act = (i) => {
      if (i === this.you || !live) return '';
      if (this.isAlly(i)) return `<button class="mini-btn give" data-give="${i}" title="Send people">👥 Send</button><button class="mini-btn bad" data-betray="${i}" title="Betray">🗡️</button>`;
      if (this.sentReq.has(i)) return '<span class="mini-note">Asked…</span>';
      if (this.gotReq.has(i)) return `<button class="mini-btn go" data-accept="${i}">Accept</button>`;
      return `<button class="mini-btn" data-ally="${i}">🤝 Ally</button>`;
    };
    lb.innerHTML = '<h4>Countries</h4>' + rows.map((o, k) => `<div class="lb-row ${o.i === this.you ? 'me' : ''} ${this.isAlly(o.i) ? 'ally' : ''}"><span class="rk">${k + 1}</span><i style="background:${this.info[o.i].color}"></i><span class="nm">${esc(this.info[o.i].country)}<small data-pct="${o.i}">${pct(o)}</small></span>${act(o.i)}</div>`).join('')
      + (live ? '<p class="lb-tip">Allies can\'t invade or shell each other. Tap an ally\'s land to send people.</p>' : '')
      + this.heldHtml();
    for (const b of lb.querySelectorAll('[data-ally]')) b.onclick = () => this.send({ type: 'ally', to: +b.dataset.ally });
    for (const b of lb.querySelectorAll('[data-accept]')) b.onclick = () => this.send({ type: 'allyAnswer', from: +b.dataset.accept, yes: true });
    for (const b of lb.querySelectorAll('[data-give]')) b.onclick = () => this.askGive(+b.dataset.give);
    for (const b of lb.querySelectorAll('[data-betray]')) b.onclick = () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Sure?'; setTimeout(() => { delete b.dataset.armed; b.textContent = '🗡️'; }, 2500); return; }
      this.send({ type: 'betray', to: +b.dataset.betray });
    };
  }

  fightBack() {
    const a = this.incoming; if (!a) return;
    // send troops at the attacker's land that touches ours, nearest to their push
    let best = -1;
    for (let i = 0; i < W * H; i++) {
      if (this.owner[i] !== a.a) continue; const x = i % W;
      if ((x > 0 && this.owner[i - 1] === this.you) || (x < W - 1 && this.owner[i + 1] === this.you) || this.owner[i - W] === this.you || this.owner[i + W] === this.you) { best = i; if (Math.random() < 0.02) break; }
    }
    if (best < 0) return this.toast('Their troops came by sea. Hold on, or hit their land directly.', 'info');
    const ratio = Math.max(this.ratio, Math.min(0.8, (a.n / Math.max(1, this.me().troops)) * 0.9));
    this.send({ type: 'attack', tile: best, ratio });
    this.effects.push({ k: 'ping', x: best % W + 0.5, y: ((best / W) | 0) + 0.5, t0: performance.now(), dur: 600 });
  }

  // ---------- inspector ----------
  select(sel) {
    this.selected = sel;
    const panel = $('.inspector', this.root);
    $('.hud-bl', this.root).classList.toggle('hidden', !!sel && this.vh < 560);
    if (!sel) { panel.classList.add('hidden'); return; }
    this.closeStrip();
    panel.classList.remove('hidden'); panel._key = ''; this.renderInspector();
  }
  renderInspector() {
    const panel = $('.inspector', this.root), sel = this.selected;
    const obj = sel.kind === 'b' ? this.buildings.find(b => b.id === sel.id) : this.ships.find(s => s.id === sel.id);
    if (!obj) return this.select(null);
    const type = sel.kind === 'b' ? obj.type : 'ship';
    const ownerIdx = obj.owner ?? obj.o, mine = ownerIdx === this.you;
    const name = type === 'ship' ? SHIP.name : type === 'capital' ? CAPITAL.name : BUILDINGS[type].name;
    const cost = obj.level < 3 && type !== 'capital' ? Math.round((type === 'ship' ? SHIP.cost : BUILDINGS[type].cost) * UPGRADE_MULT[obj.level + 1]) : 0;
    const money = this.me()?.money || 0;
    const key = `${obj.id}:${obj.level}:${mine}:${obj.dis}:${money >= cost}:${obj.hp}`;
    if (panel._key === key) return; panel._key = key;
    const owner = this.info[ownerIdx];
    panel.innerHTML = `<div class="insp-head"><span class="ci">${ICON[type]}</span><div><b>${name}</b><small></small></div><button class="icon-btn ins-x" aria-label="Close">${SVG.x}</button></div>
      ${mine && cost ? `<button class="btn ${money >= cost ? 'go' : ''} ins-up" ${money < cost ? 'disabled' : ''}>Upgrade to level ${obj.level + 1} · $${fmt(cost)}</button>` : ''}
      ${mine && type === 'ship' ? '<button class="btn ins-move">Sail somewhere</button>' : ''}
      ${type === 'capital' ? '' : `<div class="lv">${[1, 2, 3].map(l => `<i class="${l <= obj.level ? 'on' : ''}"></i>`).join('')}</div>`}
      <div class="insp-stat">${statLine(type, obj.level)}${obj.dis ? ' · <span class="bad">knocked out by EMP</span>' : ''}</div>
      ${mine && cost ? `<div class="insp-next">Level ${obj.level + 1}: ${statLine(type, obj.level + 1)}</div>` : ''}`;
    $('small', panel).textContent = (type === 'capital' ? '' : `Level ${obj.level} · `) + (owner ? owner.country : '');
    $('.ins-x', panel).onclick = () => { this.select(null); if (this.mode.kind === 'ship') this.setMode({ kind: 'attack' }); };
    const up = $('.ins-up', panel); if (up) up.onclick = () => this.send({ type: 'upgrade', id: obj.id });
    const mv = $('.ins-move', panel); if (mv) mv.onclick = () => this.setMode({ kind: 'ship', id: obj.id });
  }

  // ---------- input ----------
  bindInput() {
    const c = this.canvas; const pts = new Map(); let drag = null, pinch = null, moved = 0, downAt = 0;
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this._triedLandscape) { this._triedLandscape = true; this.goLandscape(); }
      c.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.fly = null;
      if (pts.size === 1) { drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y }; moved = 0; downAt = performance.now(); }
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.cam.s }; moved = 99; }
    });
    c.addEventListener('pointermove', (e) => {
      this.hover = this.screenToWorld(e.clientX, e.clientY);
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.s * d / pinch.d) / this.cam.s);
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; moved = Math.max(moved, Math.hypot(dx, dy));
        if (moved > 8) { this.cam.x = drag.cx - dx / this.cam.s; this.cam.y = drag.cy - dy / this.cam.s; this.clampCam(); }
      }
    });
    const up = (e) => {
      const wasTap = pts.size === 1 && moved <= 8 && performance.now() - downAt < 600;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) { const [p] = [...pts.values()]; drag = { x: p.x, y: p.y, cx: this.cam.x, cy: this.cam.y }; }
      if (!pts.size) drag = null;
      if (wasTap && e.type === 'pointerup') this.tap(e.clientX, e.clientY);
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.fly = null; this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this._key = (e) => { if (e.key === 'Escape') { this.setMode({ kind: 'attack' }); this.select(null); this.closeStrip(); } };
    window.addEventListener('keydown', this._key);
  }
  screenToWorld(sx, sy) { const r = this.canvas.getBoundingClientRect(); return { x: (sx - r.left - this.vw / 2) / this.cam.s + this.cam.x, y: (sy - r.top - this.vh / 2) / this.cam.s + this.cam.y }; }
  zoomAt(sx, sy, f) {
    const before = this.screenToWorld(sx, sy);
    this.cam.s = Math.min(48, Math.max(this.minScale, this.cam.s * f));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x; this.cam.y += before.y - after.y; this.clampCam();
  }
  clampCam() { this.cam.x = Math.max(0, Math.min(W, this.cam.x)); this.cam.y = Math.max(0, Math.min(H, this.cam.y)); }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.vw = this.root.clientWidth; this.vh = this.root.clientHeight; this.dpr = dpr;
    this.canvas.width = this.vw * dpr; this.canvas.height = this.vh * dpr;
    this.minScale = Math.min(this.vw / W, this.vh / H) * 0.9;
    if (this.cam.s < this.minScale) this.cam.s = this.minScale;
    const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    $('.rotate', this.root)?.classList.toggle('show', touch && this.vh > this.vw && this.vw < 820);
  }
  fitWorld() { this.cam.s = Math.max(this.minScale, Math.min(this.vw / W, this.vh / H) * 1.15); this.cam.x = W / 2; this.cam.y = H / 2 - 4; }
  centerOn(x, y, s) { this.cam.x = x; this.cam.y = y; if (s) this.cam.s = Math.max(this.cam.s, s); this.clampCam(); }

  tap(sx, sy) {
    const w = this.screenToWorld(sx, sy); const x = Math.floor(w.x), y = Math.floor(w.y);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const tile = y * W + x;
    if (!$('.strip', this.root).classList.contains('hidden')) { this.closeStrip(); return; }
    for (const p of this.root.querySelectorAll('.side-panel:not(.hidden)')) { p.classList.add('hidden'); $('.b-lb', this.root).classList.remove('on'); $('.b-chat', this.root).classList.remove('on'); }
    if (this.phase === 'spawn') {
      if (!this.land[tile]) return this.toast('Pick a spot on land.', 'error');
      if (!this.named) this.askName(tile); else this.send({ type: 'spawn', tile });
      return;
    }
    if (this.phase !== 'play') return;
    const m = this.mode;
    if (m.kind === 'build') {
      this.send({ type: 'build', what: m.what, tile });
      this.effects.push({ k: 'ping', x: w.x, y: w.y, t0: performance.now(), dur: 500 });
      this.setMode({ kind: 'attack' }); return;
    }
    if (m.kind === 'bomb') { this.send({ type: 'bomb', what: m.what, tile }); this.setMode({ kind: 'attack' }); return; }
    if (m.kind === 'ship') { this.send({ type: 'moveShip', id: m.id, tile }); this.toast('Setting sail'); this.setMode({ kind: 'attack' }); return; }
    // pick a building or ship under the finger
    const rad = Math.max(1.6, 22 / this.cam.s);
    let best = null, bd = rad * rad;
    for (const s of this.ships) { const d = (s.x + 0.5 - w.x) ** 2 + (s.y + 0.5 - w.y) ** 2; if (d < bd) { bd = d; best = { kind: 's', id: s.id, o: s.o }; } }
    for (const b of this.buildings) { const d = (b.x + 0.5 - w.x) ** 2 + (b.y + 0.5 - w.y) ** 2; if (d < bd) { bd = d; best = { kind: 'b', id: b.id, o: b.owner }; } }
    if (best && best.o === this.you) {
      this.select(best);
      if (best.kind === 's') this.setMode({ kind: 'ship', id: best.id });
      return;
    }
    if (this.selected) { this.select(null); return; }
    if (!this.land[tile] || this.owner[tile] === this.you) return;
    if (this.isAlly(this.owner[tile])) { this.askGive(this.owner[tile]); return; }
    this.send({ type: 'attack', tile, ratio: this.ratio });
    this.effects.push({ k: 'ping', x: w.x, y: w.y, t0: performance.now(), dur: 500 });
    // tapped land an outpost guards, but not the outpost itself: explain once in a while
    const foe = this.owner[tile];
    if (foe >= 0 && performance.now() - (this.guardHintAt || 0) > 15000) {
      let guard = null, aimed = false;
      for (const b of this.buildings) {
        if (b.type !== 'outpost' || b.owner !== foe) continue;
        const d = (b.x - x) ** 2 + (b.y - y) ** 2, r = LS.outpost.radius[b.level];
        if (d <= 25) aimed = true; else if (d <= r * r) guard = b;
      }
      if (guard && !aimed) { this.guardHintAt = performance.now(); this.toast(`An outpost guards this land, so it's ${LS.outpost.defense[guard.level]}x harder to take. Tap the outpost itself to charge straight at it.`, 'warn'); }
    }
    let nearMe = false;
    for (let dy = -2; dy <= 2 && !nearMe; dy++) for (let dx = -2; dx <= 2; dx++) { const t = (y + dy) * W + x + dx; if (t >= 0 && t < W * H && this.owner[t] === this.you) { nearMe = true; break; } }
    if (nearMe && this.owner[tile] === -1 && !this.supply[tile] && performance.now() - this.supplyHintAt > 20000) {
      this.supplyHintAt = performance.now(); this.supplyFlash = performance.now();
      this.toast('That land is outside your supply range, so it costs 3x the people. Build a City or Outpost near your border.', 'warn');
    }
  }

  // ---------- drawing ----------
  frame() {
    if (!this.running) return;
    requestAnimationFrame(() => this.frame());
    const ctx = this.ctx, now = performance.now(), s0 = this.cam.s, dpr = this.dpr;
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.t0) / 900), e = 1 - (1 - t) ** 3;
      this.cam.x = this.fly.x0 + (this.fly.x - this.fly.x0) * e; this.cam.y = this.fly.y0 + (this.fly.y - this.fly.y0) * e; this.cam.s = this.fly.s0 + (this.fly.s - this.fly.s0) * e;
      if (t >= 1) this.fly = null;
    }
    const s = this.cam.s; void s0;
    this.painter.flush();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07101f'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    let shx = 0, shy = 0; if (this.shake > 0.2) { shx = (Math.random() - 0.5) * this.shake; shy = (Math.random() - 0.5) * this.shake; this.shake *= 0.92; }
    ctx.setTransform(s * dpr, 0, 0, s * dpr, (this.vw / 2 - this.cam.x * s + shx) * dpr, (this.vh / 2 - this.cam.y * s + shy) * dpr);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.painter.canvas, 0, 0, W, H);
    const px = 1 / s; // one screen pixel in world units

    // supply range: always faint, bright while building or right after a hint
    const showSupply = this.mode.kind === 'build' || (this.supplyFlash && now - this.supplyFlash < 4000);
    ctx.globalAlpha = showSupply ? 0.7 : 0.25; ctx.drawImage(this.supplyCanvas, 0, 0); ctx.globalAlpha = 1;
    // outline of the supply area: the outer edge of the union of all supply circles
    const src = this.supplySources || [];
    ctx.strokeStyle = showSupply ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)'; ctx.lineWidth = (showSupply ? 2.5 : 1.5) * px;
    ctx.setLineDash([6 * px, 5 * px]); ctx.lineDashOffset = -now / 60 * px;
    ctx.beginPath();
    for (const a of src) {
      const n = Math.max(48, Math.ceil(a.r * 6)); let pen = false;
      for (let k = 0; k <= n; k++) {
        const t = k / n * Math.PI * 2, x = a.x + Math.cos(t) * a.r, y = a.y + Math.sin(t) * a.r;
        const inside = src.some(b => b !== a && (x - b.x) ** 2 + (y - b.y) ** 2 < b.r * b.r - 0.01);
        if (inside) { pen = false; continue; }
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
    }
    ctx.stroke(); ctx.setLineDash([]);
    // land each outpost guards: a tinted circle in the owner's color
    if (s > 1.2) for (const b of this.buildings) {
      if (b.type !== 'outpost') continue;
      const r = LS.outpost.radius[b.level], c = this.info[b.owner]?.color || '#888';
      ctx.beginPath(); ctx.arc(b.x + 0.5, b.y + 0.5, r, 0, 7);
      ctx.globalAlpha = 0.1; ctx.fillStyle = c; ctx.fill();
      ctx.globalAlpha = 0.75; ctx.strokeStyle = c; ctx.lineWidth = 2 * px; ctx.stroke();
      ctx.globalAlpha = 0.5; ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8 * px; ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (this.selected) {
      const o = this.selected.kind === 'b' ? this.buildings.find(b => b.id === this.selected.id) : this.ships.find(b => b.id === this.selected.id);
      const type = this.selected.kind === 'b' ? o?.type : 'ship';
      const r = o && (type === 'ship' ? LS.ship.range[o.level] : LS[type]?.radius?.[o.level]);
      if (r) { ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.setLineDash([5 * px, 5 * px]); ctx.lineWidth = 2 * px; ctx.beginPath(); ctx.arc(o.x + 0.5, o.y + 0.5, r, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    }
    if (this.mode.kind === 'bomb' && this.hover) {
      const r = BOMBS[this.mode.what].radius * (this.mode.what === 'cluster' ? 4 : 1);
      ctx.fillStyle = 'rgba(255,60,30,0.18)'; ctx.strokeStyle = 'rgba(255,80,40,0.9)'; ctx.lineWidth = 2 * px;
      ctx.beginPath(); ctx.arc(this.hover.x, this.hover.y, r, 0, 7); ctx.fill(); ctx.stroke();
    }
    if (this.mode.kind === 'build') {
      for (const b of this.buildings) if (b.owner === this.you && LS[b.type]?.radius && b.type === this.mode.what) { ctx.strokeStyle = 'rgba(120,200,255,0.6)'; ctx.lineWidth = 1.5 * px; ctx.beginPath(); ctx.arc(b.x + 0.5, b.y + 0.5, LS[b.type].radius[b.level], 0, 7); ctx.stroke(); }
      if (this.hover) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * px; ctx.beginPath(); ctx.arc(Math.floor(this.hover.x) + 0.5, Math.floor(this.hover.y) + 0.5, Math.max(1.3, 14 * px), 0, 7); ctx.stroke(); }
    }

    // country names
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    this.stats.forEach((st, i) => {
      if (!st.alive || st.tiles < 4 || st.cx < 0) return;
      const inf = this.info[i]; if (!inf) return;
      if (inf.tribe) {
        if (s < 3.5) return;
        ctx.font = `800 ${11 * px}px Nunito, system-ui, sans-serif`; ctx.lineJoin = 'round'; ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(8,12,24,0.6)'; ctx.fillStyle = '#d5d9e2';
        ctx.strokeText(inf.country, st.cx + 0.5, st.cy + 0.5); ctx.fillText(inf.country, st.cx + 0.5, st.cy + 0.5); return;
      }
      const fs = Math.max(10 * px, Math.min(Math.sqrt(st.tiles) * 0.45, 22 * px));
      ctx.font = `900 ${fs}px Nunito, system-ui, sans-serif`;
      ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.22; ctx.strokeStyle = 'rgba(8,12,24,0.75)'; ctx.fillStyle = '#fff';
      const label = inf.country;
      ctx.strokeText(label, st.cx + 0.5, st.cy + 0.5); ctx.fillText(label, st.cx + 0.5, st.cy + 0.5);
      if (this.isAlly(i)) {
        // a bright "ALLY" tag above the name so allies stand out at a glance
        const tf = fs * 0.55; ctx.font = `900 ${tf}px Nunito, system-ui, sans-serif`;
        const tag = '🤝 ALLY', tw = ctx.measureText(tag).width + tf * 1.1, th = tf * 1.5, ty = st.cy + 0.5 - fs * 1.05;
        ctx.fillStyle = '#2ee6a6'; ctx.strokeStyle = 'rgba(8,12,24,0.8)'; ctx.lineWidth = tf * 0.14;
        ctx.beginPath(); ctx.roundRect(st.cx + 0.5 - tw / 2, ty - th / 2, tw, th, th / 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#06261b'; ctx.textBaseline = 'middle'; ctx.fillText(tag, st.cx + 0.5, ty + tf * 0.05);
        ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff'; ctx.font = `900 ${fs}px Nunito, system-ui, sans-serif`;
      }
      ctx.font = `800 ${fs * 0.62}px Nunito, system-ui, sans-serif`;
      const away = this.awayOf(i);
      const line = away ? `${fmt(st.troops)} · ⚔️ ${fmt(away)} away` : fmt(st.troops);
      ctx.lineWidth = fs * 0.16; ctx.strokeText(line, st.cx + 0.5, st.cy + 0.5 + fs * 0.85); ctx.fillText(line, st.cx + 0.5, st.cy + 0.5 + fs * 0.85);
    });

    // real-country names, faint, when zoomed in; held ones get a star in the holder's color
    if (s > 3.2) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      const fs = 10 * px;
      for (let r = 0; r < this.regions.list.length; r++) {
        const R = this.regions.list[r]; if (R.size < 40 && s < 7) continue;
        const x = R.cx + 0.5, y = R.cy + 0.5;
        if (x < this.cam.x - this.vw / 2 / s - 5 || x > this.cam.x + this.vw / 2 / s + 5 || y < this.cam.y - this.vh / 2 / s - 5 || y > this.cam.y + this.vh / 2 / s + 5) continue;
        const h = this.regHolder[r] ?? -1;
        const label = (h >= 0 ? '⭐ ' : '') + R.name.toUpperCase() + `  +${R.bonus}`;
        ctx.font = `800 ${fs}px Nunito, system-ui, sans-serif`;
        ctx.globalAlpha = h >= 0 ? 0.95 : 0.6; ctx.lineWidth = 2.5 * px; ctx.strokeStyle = 'rgba(8,12,24,0.7)';
        ctx.fillStyle = h >= 0 ? (this.info[h]?.color || '#fff') : '#e8ecf4';
        ctx.strokeText(label, x, y + 22 * px); ctx.fillText(label, x, y + 22 * px);
      }
      ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
    }
    // buildings: big round pins when zoomed in, small dots when far out
    const f = Math.min(1, (now - this.lastPatchAt) / TICK_MS);
    if (s < 2.2) { for (const b of this.buildings) drawDot(ctx, b, this.info[b.owner]?.color || '#888', 5 * px); }
    else { const size = Math.min(48 * px, Math.max(26 * px, 2.4)); for (const b of this.buildings) drawBuilding(ctx, b, this.info[b.owner]?.color || '#888', b.owner === this.you || b.type === 'capital' ? size : size * 0.8, b.owner === this.you); }
    this.drawArmies(ctx, px, now);
    const lerp = (cur, prev) => prev ? { ...cur, x: prev.x + (cur.x - prev.x) * f, y: prev.y + (cur.y - prev.y) * f } : cur;
    for (const sh of this.ships) drawShip(ctx, lerp(sh, this.prev.ships.get(sh.id)), this.info[sh.o]?.color || '#888', Math.min(60 * px, Math.max(32 * px, 2.8)), now);
    for (const bt0 of this.boats) {
      const bt = lerp(bt0, this.prev.boats.get(bt0.id)); const size = Math.min(40 * px, Math.max(24 * px, 1.8));
      drawBoat(ctx, bt, this.info[bt.o]?.color || '#888', size, now);
      const label = fmt(bt.n); ctx.font = `900 ${11 * px}px Nunito, system-ui`;
      const tw = ctx.measureText(label).width + 10 * px, lx = bt.x + 0.5, ly = bt.y + 0.5 - size * 0.85;
      ctx.fillStyle = this.info[bt.o]?.color || '#888'; ctx.beginPath(); ctx.roundRect(lx - tw / 2, ly - 8 * px, tw, 16 * px, 8 * px); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2.5 * px; ctx.strokeText(label, lx, ly + px); ctx.fillText(label, lx, ly + px);
    }

    // missiles (interpolated between server ticks)
    for (const m of this.missiles) {
      const prev = this.prev.ms.get(m.id); const p0 = prev ? prev.p : m.p; const p = p0 + (m.p - p0) * f;
      const dist = Math.hypot(m.tx - m.fx, m.ty - m.fy), hgt = Math.min(40, dist * 0.35) * (m.type === 'mini' ? 0.2 : 1);
      const pos = (q) => [m.fx + (m.tx - m.fx) * q + 0.5, m.fy + (m.ty - m.fy) * q + 0.5 - Math.sin(Math.PI * q) * hgt];
      ctx.strokeStyle = m.o === this.you ? 'rgba(255,255,255,0.35)' : 'rgba(255,80,60,0.5)'; ctx.lineWidth = 1.5 * px; ctx.setLineDash([3 * px, 3 * px]);
      ctx.beginPath(); for (let q = p; q <= 1.0001; q += 0.04) { const [x, y] = pos(Math.min(1, q)); ctx.lineTo(x, y); } ctx.stroke(); ctx.setLineDash([]);
      // ground shadow under the missile, so you can tell how high it is
      const gq = p, gx = m.fx + (m.tx - m.fx) * gq + 0.5, gy = m.fy + (m.ty - m.fy) * gq + 0.5, lift = Math.sin(Math.PI * p) * hgt;
      const size = (m.type === 'bigone' ? 1.9 : m.type === 'hydrogen' ? 1.5 : m.type === 'mini' ? 0.55 : 1.15) * px;
      ctx.fillStyle = `rgba(0,0,0,${0.28 - Math.min(0.18, lift * 0.006)})`; ctx.beginPath(); ctx.ellipse(gx, gy, (7 + lift * 0.08) * size, (3 + lift * 0.04) * size, 0, 0, 7); ctx.fill();
      // smoke trail: soft puffs that grow and fade behind the missile
      const tail = m.type === 'mini' ? 0.1 : 0.22;
      for (let k = 28; k >= 1; k--) {
        const q = p - tail * k / 28; if (q < 0) continue;
        const [sx, sy] = pos(q), a = (1 - k / 28) * 0.4;
        ctx.fillStyle = m.type === 'emp' ? `rgba(140,220,255,${a})` : `rgba(205,208,218,${a})`;
        ctx.beginPath(); ctx.arc(sx, sy, (1.6 + k * 0.22) * size, 0, 7); ctx.fill();
      }
      const [x, y] = pos(p), [ax, ay] = pos(Math.min(1, p + 0.01));
      drawMissile(ctx, x, y, Math.atan2(ay - y, ax - x), m.type, this.info[m.o]?.color || '#f33', size, now);
      if (m.o !== this.you && m.type !== 'mini') { ctx.strokeStyle = 'rgba(255,40,40,0.85)'; ctx.lineWidth = 2 * px; const r = (m.type === 'cluster' ? 12 : BOMBS[m.type].radius); ctx.beginPath(); ctx.arc(m.tx + 0.5, m.ty + 0.5, r, 0, 7); ctx.stroke(); }
    }

    // effects
    this.effects = this.effects.filter(e => now - e.t0 < e.dur);
    for (const e of this.effects) {
      const t = (now - e.t0) / e.dur;
      if (e.k === 'boom') {
        const r = e.r * (0.3 + 0.9 * Math.sqrt(t));
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, Math.max(0.1, r));
        const a = 1 - t;
        if (e.type === 'emp') { g.addColorStop(0, `rgba(160,230,255,${a})`); g.addColorStop(1, 'rgba(80,160,255,0)'); }
        else { g.addColorStop(0, `rgba(255,255,220,${a})`); g.addColorStop(0.35, `rgba(255,170,40,${a * 0.9})`); g.addColorStop(0.75, `rgba(200,40,20,${a * 0.6})`); g.addColorStop(1, 'rgba(60,20,10,0)'); }
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, 7); ctx.fill();
        if (e.r >= 7) { ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.7})`; ctx.lineWidth = 2 * px; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.5 + t * 1.6), 0, 7); ctx.stroke(); }
      } else if (e.k === 'line') { ctx.strokeStyle = e.c; ctx.globalAlpha = 1 - t; ctx.lineWidth = 2 * px; ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke(); ctx.globalAlpha = 1; }
      else if (e.k === 'give') {
        // a stream of dots flowing from giver to receiver
        ctx.fillStyle = e.c;
        for (let k = 0; k < 6; k++) { const q = (t * 1.4 - k * 0.08); if (q < 0 || q > 1) continue; const x = e.x1 + (e.x2 - e.x1) * q, y = e.y1 + (e.y2 - e.y1) * q - Math.sin(Math.PI * q) * 6; ctx.beginPath(); ctx.arc(x, y, 3.5 * px, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2 * px; ctx.stroke(); }
      }
      else if (e.k === 'debris') {
        for (const b of e.bits) {
          const x = e.x + b.dx * t, y = e.y + b.dy * t - Math.sin(Math.PI * Math.min(1, t * 1.2)) * 1.5 * b.s;
          ctx.globalAlpha = 1 - t * t; ctx.fillStyle = b.s > 1 ? '#3a2a20' : '#ffb347';
          const z = (0.25 + 0.25 * b.s) * Math.max(1, 3 * px);
          ctx.fillRect(x - z / 2, y - z / 2, z, z);
        }
        ctx.globalAlpha = 1;
      }
      else if (e.k === 'smoke') {
        for (let k = 0; k < 5; k++) {
          const q = t * 0.9 + k * 0.03, rr = e.r * (0.3 + q * 0.8) * (0.7 + k * 0.1);
          ctx.globalAlpha = Math.max(0, 0.32 * (1 - t)); ctx.fillStyle = '#2a2a2e';
          ctx.beginPath(); ctx.arc(e.x + Math.sin(k * 2.1) * e.r * 0.4, e.y - q * e.r * 0.9 + Math.cos(k * 1.7) * e.r * 0.3, rr, 0, 7); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      else if (e.k === 'ping') { ctx.strokeStyle = `rgba(255,255,255,${1 - t})`; ctx.lineWidth = 3 * px; ctx.beginPath(); ctx.arc(e.x, e.y, (6 + t * 16) * px, 0, 7); ctx.stroke(); }
    }
    const flash = this.effects.find(e => e.k === 'flash');
    if (flash) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(255,250,230,${0.85 * (1 - (now - flash.t0) / flash.dur)})`; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
  }
}

function paintRange(el) { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); }

function statLine(type, lv) {
  const S = LS[type];
  switch (type) {
    case 'capital': return `+${fmt(CAPITAL.maxTroops)} max people, +${CAPITAL.growth} growth, supply range ${CAPITAL.supply}. Lose it and it's gone for good.`;
    case 'city': return `+${fmt(S.maxTroops[lv])} max people, +${S.growth[lv]}/s growth, +$${S.money[lv]}/s, supply ${S.supply[lv]}`;
    case 'factory': return `+$${S.money[lv]}/s`;
    case 'military': return `+${Math.round(S.growth[lv] * 100)}% troop growth, +${fmt(S.maxTroops[lv])} max troops`;
    case 'port': return `+$${S.money[lv]}/s, faster boats, supply ${S.supply[lv]}`;
    case 'outpost': return `Land within ${S.radius[lv]} is ${S.defense[lv]}x harder to take and slower to fall, unless attackers charge the outpost itself. Supply ${S.supply[lv]}`;
    case 'silo': return `Reloads in ${S.cooldown[lv] / 10}s · ${Object.values(BOMBS).filter(b => b.silo === lv).map(b => b.name).join(', ')} unlocked`;
    case 'battery': return `Range ${S.radius[lv]} · ${Math.round(S.chance[lv] * 100)}% hit · reload ${S.cooldown[lv] / 10}s`;
    case 'radar': return `Batteries within ${S.radius[lv]} get +${Math.round(S.boost[lv] * 100)}% hit chance`;
    case 'ship': return `HP ${S.hp[lv]} · range ${S.range[lv]} · damage ${S.damage[lv]}`;
  }
  return '';
}
export { paintRange };

// Authoritative game simulation. Runs on the server for online games and in the
// browser for offline games against bots. Produces a "patch" every tick that
// clients apply to their view of the world.
import { MAP_W as W, MAP_H as H, getLand } from './map.js';
import { BUILDINGS, SHIP, CAPITAL, UPGRADE_MULT, LEVEL_STATS as LS, BUILDING_HP, BOMBS, ECON, TICK_MS } from './rules.js';
import { botThink } from './bots.js';

const N = W * H;
const TRIBE_A = ['Ash', 'Stone', 'River', 'Iron', 'Wolf', 'Salt', 'Oak', 'Dust', 'Frost', 'Reed', 'Hill', 'Bone', 'Ember', 'Cedar', 'Storm'];
const TRIBE_B = ['Tribe', 'Clan', 'Folk', 'Band', 'Kin'];
const TPS = 1000 / TICK_MS;

export function tileXY(i) { return [i % W, (i / W) | 0]; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

export class Engine {
  constructor({ players, settings = {} }) {
    this.settings = Object.assign({ spawnTime: 20, startMoney: ECON.startMoney, winPercent: 60, speed: 1, tribes: true }, settings);
    this.land = getLand();
    this.landCount = this.land.reduce((a, b) => a + b, 0);
    this.coastal = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (this.land[i]) for (const n of this.nb(i)) if (!this.land[n]) { this.coastal[i] = 1; break; }
    this.owner = new Int16Array(N).fill(-1);
    this.fallout = new Uint16Array(N);
    this.tilePos = new Int32Array(N).fill(-1);
    this.players = players.map((p, idx) => ({
      idx, id: p.id, name: p.name, color: p.color, isBot: !!p.isBot,
      country: p.country || `${p.name}'s Country`,
      troops: ECON.startTroops, money: this.settings.startMoney, tiles: [], sx: 0, sy: 0,
      alive: true, spawned: false, maxTroops: ECON.baseMaxTroops, growth: 0, income: 0,
      kills: 0, bombsLaunched: 0, peakTiles: 0, eliminatedAt: 0, botState: {},
    }));
    this.tick = 0;
    this.phase = 'spawn';
    this.spawnEnd = this.settings.spawnTime * TPS;
    this.nextId = 1;
    this.attacks = []; this.boats = []; this.missiles = []; this.ships = []; this.buildings = [];
    this.buildingAt = new Map();
    this.changes = []; this.events = [];
    this.buildingsDirty = true; this.infoDirty = true; this.supplyDirty = true;
    this.supply = this.players.map(() => new Uint8Array(N));
    this.winner = null;
    for (const p of this.players) if (p.isBot) this.randomSpawn(p);
    this.nextTribeAt = 0;
    if (this.settings.tribes) for (let k = 0; k < 10; k++) this.spawnTribe();
  }

  // ---------- helpers ----------
  nb(i) {
    const x = i % W, out = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (i >= W) out.push(i - W);
    if (i < N - W) out.push(i + W);
    return out;
  }
  msg(p, text, kind = 'info') { this.events.push({ k: 'msg', to: p.id, text, kind }); }
  setOwner(i, pidx) {
    const old = this.owner[i];
    if (old === pidx) return;
    const x = i % W, y = (i / W) | 0;
    if (old >= 0) {
      const op = this.players[old], pos = this.tilePos[i], last = op.tiles.pop();
      if (last !== i) { op.tiles[pos] = last; this.tilePos[last] = pos; }
      this.tilePos[i] = -1; op.sx -= x; op.sy -= y;
    }
    this.owner[i] = pidx;
    if (pidx >= 0) {
      const np = this.players[pidx];
      this.tilePos[i] = np.tiles.length; np.tiles.push(i); np.sx += x; np.sy += y;
      if (np.tiles.length > np.peakTiles) np.peakTiles = np.tiles.length;
    }
    const b = this.buildingAt.get(i);
    if (b) {
      if (pidx >= 0 && b.type !== 'capital') b.owner = pidx;
      else { if (b.type === 'capital' && pidx >= 0) { this.events.push({ k: 'msg', text: `${this.players[pidx].country} captured the capital of ${this.players[b.owner].country}!`, kind: 'warn' }); this.players[pidx].money += 2000; } this.destroyBuilding(b); }
      this.buildingsDirty = true;
    }
    this.changes.push(i, pidx);
  }
  destroyBuilding(b) {
    this.buildings = this.buildings.filter(o => o !== b);
    this.buildingAt.delete(b.tile);
    this.buildingsDirty = true; this.supplyDirty = true;
  }
  // Supply range: land near your capital, cities, outposts and ports is cheap and quick to take.
  supplyRadius(b) {
    if (b.disabled > this.tick) return 0;
    if (b.type === 'capital') return CAPITAL.supply;
    return LS[b.type]?.supply?.[b.level] || 0;
  }
  refreshSupply() {
    if (!this.supplyDirty) return;
    this.supplyDirty = false;
    for (const m of this.supply) m.fill(0);
    for (const b of this.buildings) {
      const r = this.supplyRadius(b); if (!r) continue;
      const m = this.supply[b.owner], R = Math.ceil(r);
      for (let dy = -R; dy <= R; dy++) { const y = b.y + dy; if (y < 0 || y >= H) continue;
        for (let dx = -R; dx <= R; dx++) { const x = b.x + dx; if (x < 0 || x >= W || dx * dx + dy * dy > r * r) continue; m[y * W + x] = 1; } }
    }
  }
  // Water route between tiles using 8-way moves, then straightened into a few smooth waypoints.
  waterRoute(starts, isGoal) {
    const prev = new Int32Array(N).fill(-2); const q = [];
    for (const s of starts) { prev[s] = -1; q.push(s); }
    let goal = -1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h]; if (isGoal(i)) { goal = i; break; }
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const n = ny * W + nx; if (this.land[n] || prev[n] !== -2) continue;
        if (dx && dy && (this.land[y * W + nx] || this.land[ny * W + x])) continue; // don't cut corners
        prev[n] = i; q.push(n);
      }
    }
    if (goal < 0) return null;
    const tiles = []; for (let i = goal; i !== -1; i = prev[i]) tiles.push(i);
    return tiles; // goal first, start last
  }
  clearLine(a, b) {
    const ax = a % W + 0.5, ay = ((a / W) | 0) + 0.5, bx = b % W + 0.5, by = ((b / W) | 0) + 0.5;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 3);
    for (let k = 1; k < n; k++) { const t = k / n; for (const o of [-0.3, 0.3]) { const x = Math.floor(ax + (bx - ax) * t + o), y = Math.floor(ay + (by - ay) * t + o); if (x < 0 || x >= W || y < 0 || y >= H || this.land[y * W + x]) return false; } }
    return true;
  }
  smooth(tiles) {
    const pts = [tiles[0]]; let i = 0;
    while (i < tiles.length - 1) {
      let j = Math.min(tiles.length - 1, i + 60);
      while (j > i + 1 && !this.clearLine(tiles[i], tiles[j])) j--;
      pts.push(tiles[j]); i = j;
    }
    return pts.map(t => [t % W, (t / W) | 0]);
  }
  // Advance something along a waypoint list at `speed` tiles per tick. Returns true when it arrives.
  advance(o, speed) {
    let left = speed;
    while (left > 0 && o.wi < o.wp.length - 1) {
      const [tx, ty] = o.wp[o.wi + 1]; const dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy);
      if (d > 0.001) o.ang = Math.atan2(dy, dx);
      if (d <= left) { o.x = tx; o.y = ty; o.wi++; left -= d; } else { o.x += dx / d * left; o.y += dy / d * left; left = 0; }
    }
    return o.wi >= o.wp.length - 1;
  }
  levelOf(p, type) { let best = 0; for (const b of this.buildings) if (b.owner === p.idx && b.type === type) best = Math.max(best, b.level); return best; }
  countOf(p, type) { let c = 0; for (const b of this.buildings) if (b.owner === p.idx && b.type === type) c++; return c; }
  buildCost(p, type) {
    const base = type === 'ship' ? SHIP.cost : BUILDINGS[type].cost;
    const count = type === 'ship' ? this.ships.filter(s => s.owner === p.idx).length : this.countOf(p, type);
    return Math.round(base * (1 + 0.3 * count));
  }
  upgradeCost(type, toLevel) { const base = type === 'ship' ? SHIP.cost : BUILDINGS[type].cost; return Math.round(base * UPGRADE_MULT[toLevel]); }

  // ---------- spawning ----------
  claimSpawn(p, center) {
    const [cx, cy] = tileXY(center), r = ECON.spawnRadius;
    for (const t of [...p.tiles]) this.setOwner(t, -1);
    for (const b of this.buildings.filter(b => b.owner === p.idx)) this.destroyBuilding(b);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + 1) continue;
      const x = cx + dx, y = cy + dy; if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const i = y * W + x; if (this.land[i] && this.owner[i] === -1) this.setOwner(i, p.idx);
    }
    p.spawned = true;
    const cap = { id: this.nextId++, type: 'capital', owner: p.idx, tile: center, x: cx, y: cy, level: 1, hp: 400, cd: 0, disabled: 0 };
    this.buildings.push(cap); this.buildingAt.set(center, cap); this.buildingsDirty = true; this.supplyDirty = true;
  }
  spawnOk(center, p) {
    if (!this.land[center] || (this.owner[center] !== -1 && this.owner[center] !== p.idx)) return false;
    const [cx, cy] = tileXY(center);
    for (const o of this.players) if (o !== p && o.spawned && o.tiles.length) {
      const ox = o.sx / o.tiles.length, oy = o.sy / o.tiles.length;
      if (dist2(cx, cy, ox, oy) < 15 * 15) return false;
    }
    // need a little room
    let free = 0; const r = ECON.spawnRadius;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && x < W && y >= 0 && y < H && this.land[y * W + x]) free++; }
    return free >= 12;
  }
  randomSpawn(p) {
    for (let k = 0; k < 4000; k++) {
      const i = (Math.random() * N) | 0;
      const y = (i / W) | 0; if (y < 15 || y > H - 22) continue; // avoid the far poles
      if (this.spawnOk(i, p)) { this.claimSpawn(p, i); return; }
    }
  }

  // ---------- actions ----------
  handle(pid, a) {
    const p = this.players.find(q => q.id === pid);
    if (!p || !a) return;
    if (this.phase === 'over') return;
    if (a.type === 'rename') { p.country = String(a.country || '').slice(0, 32) || `${p.name}'s Country`; this.infoDirty = true; return; }
    if (a.type === 'spawn') {
      if (this.phase !== 'spawn') return;
      const t = a.tile | 0; if (t < 0 || t >= N) return;
      if (!this.spawnOk(t, p)) return this.msg(p, 'You can\'t start there. Pick open land away from other countries.', 'error');
      this.claimSpawn(p, t);
      if (a.country !== undefined) { p.country = String(a.country).trim().slice(0, 32) || `${p.name}'s Country`; this.infoDirty = true; }
      return;
    }
    if (this.phase !== 'play' || !p.alive) return;
    switch (a.type) {
      case 'attack': return this.doAttack(p, a.tile | 0, Math.min(1, Math.max(0.05, +a.ratio || 0.3)));
      case 'build': return this.doBuild(p, a.what, a.tile | 0);
      case 'upgrade': return this.doUpgrade(p, a.id | 0);
      case 'bomb': return this.doBomb(p, a.what, a.tile | 0);
      case 'moveShip': return this.doMoveShip(p, a.id | 0, a.tile | 0);
      case 'surrender': return this.eliminate(p);
    }
  }

  regionReach(p, start, target) {
    // BFS through tiles owned by `target` from `start`; returns the set if it touches p.
    const seen = new Set([start]), q = [start]; let touches = false;
    for (let h = 0; h < q.length && q.length < 60000; h++) {
      const i = q[h];
      for (const n of this.nb(i)) {
        if (this.owner[n] === p.idx) touches = true;
        if (!seen.has(n) && this.land[n] && this.owner[n] === target && !this.fallout[n]) { seen.add(n); q.push(n); }
      }
    }
    return touches ? seen : null;
  }

  doAttack(p, tile, ratio) {
    if (tile < 0 || tile >= N || !this.land[tile]) return;
    const target = this.owner[tile];
    if (target === p.idx) return;
    if (this.fallout[tile]) return this.msg(p, 'That land is covered in fallout. Wait for it to clear.', 'error');
    const troops = Math.floor(p.troops * ratio);
    if (troops < 10) return this.msg(p, 'Not enough people to send.', 'error');
    const region = this.regionReach(p, tile, target);
    if (!region) return this.launchBoat(p, tile, troops);
    p.troops -= troops;
    this.startAttack(p, target, troops, tile, region);
  }

  startAttack(p, target, troops, focusTile, region) {
    // opposing attack cancels troops first
    if (target >= 0) {
      const opp = this.attacks.find(a => a.a === target && a.t === p.idx);
      if (opp) {
        // fighting back against an incoming attack: defenders' troops count for more
        const power = troops * ECON.counterBonus, c = Math.min(opp.troops, power);
        opp.troops -= c; troops -= c / ECON.counterBonus;
        if (opp.troops <= 1) this.msg(this.players[target], `${p.country} pushed back your attack!`, 'error');
        if (troops <= 1) { this.msg(p, 'You held the line!', 'good'); return; }
        this.msg(p, 'You broke their attack and are pushing into their land!', 'good');
      }
    }
    let atk = this.attacks.find(a => a.a === p.idx && a.t === target);
    if (!atk) { atk = { id: this.nextId++, a: p.idx, t: target, troops: 0, acc: 0, cand: new Set(), fx: 0, fy: 0 }; this.attacks.push(atk); }
    atk.troops += troops;
    [atk.fx, atk.fy] = tileXY(focusTile);
    for (const i of p.tiles) for (const n of this.nb(i)) if (this.owner[n] === target && this.land[n] && (!region || region.has(n))) atk.cand.add(n);
  }

  defenseMult(tile, def) {
    let m = this.supply[def][tile] ? 1.3 : 1; const [x, y] = tileXY(tile);
    for (const b of this.buildings) {
      if (b.type !== 'outpost' || b.owner !== def || b.disabled > this.tick) continue;
      const r = LS.outpost.radius[b.level];
      if (dist2(x, y, b.x, b.y) <= r * r) m = Math.max(m, LS.outpost.defense[b.level]);
    }
    return m;
  }

  stepAttacks() {
    for (const atk of this.attacks) {
      const p = this.players[atk.a];
      if (!p.alive) { atk.done = true; continue; }
      const enemy = atk.t >= 0 ? this.players[atk.t] : null;
      const sup = this.supply[atk.a];
      let rate = (0.22 + Math.sqrt(atk.troops) / 30);
      if (enemy) {
        const dens = Math.max(2, enemy.troops / Math.max(1, enemy.tiles.length));
        rate *= 0.4 * Math.min(1.4, Math.max(0.25, Math.sqrt(atk.troops / (dens * 40))));
      }
      atk.acc += rate;
      if (!atk.cand.size) { atk.done = true; continue; }
      let guard = 0;
      while (atk.acc >= 1 && atk.cand.size && guard++ < 30) {
        let best = -1, bs = Infinity;
        for (const c of atk.cand) {
          const s = dist2(c % W, (c / W) | 0, atk.fx, atk.fy) * 0.02 + Math.random() * 6 + (sup[c] ? 0 : 4);
          if (s < bs) { bs = s; best = c; }
        }
        atk.cand.delete(best);
        if (this.owner[best] !== atk.t || this.fallout[best]) continue;
        if (!this.nb(best).some(m => this.owner[m] === atk.a)) continue;
        const supplied = sup[best] === 1;
        const weight = supplied ? 1 : 1 / ECON.outOfSupplySpeed;
        let cost = ECON.neutralCost * (1 + p.tiles.length / 1500), loss = 0;
        if (enemy) {
          const dens = enemy.troops / Math.max(1, enemy.tiles.length);
          cost = Math.max(3, dens * 1.3) * this.defenseMult(best, atk.t);
          loss = Math.max(1, dens * 0.5);
        }
        if (!supplied) cost *= ECON.outOfSupplyCost;
        if (atk.troops < cost) { atk.troops = 0; atk.done = true; break; }
        atk.acc -= weight;
        atk.troops -= cost;
        if (enemy) enemy.troops = Math.max(0, enemy.troops - loss);
        this.setOwner(best, atk.a);
        for (const m of this.nb(best)) if (this.owner[m] === atk.t && this.land[m]) atk.cand.add(m);
      }
      if (!atk.cand.size) atk.done = true;
    }
    for (const atk of this.attacks) if (atk.done) this.players[atk.a].troops += atk.troops;
    this.attacks = this.attacks.filter(a => !a.done);
  }

  launchBoat(p, tile, troops) {
    if (this.boats.filter(b => b.owner === p.idx).length >= ECON.maxBoats) return this.msg(p, `You can only have ${ECON.maxBoats} boats at sea.`, 'error');
    // landing tile: nearest coastal tile (not ours) to the tapped tile on that landmass
    let land = -1;
    if (this.coastal[tile]) land = tile;
    else {
      const seen = new Set([tile]), q = [tile];
      for (let h = 0; h < q.length && h < 6000; h++) {
        const i = q[h]; if (this.coastal[i] && this.owner[i] !== p.idx) { land = i; break; }
        for (const n of this.nb(i)) if (this.land[n] && !seen.has(n)) { seen.add(n); q.push(n); }
      }
    }
    if (land < 0) return this.msg(p, 'No beach to land on there.', 'error');
    // sea route from the nearest water next to our coast to the landing beach
    const starts = this.nb(land).filter(n => !this.land[n]);
    const route = this.waterRoute(starts, (i) => this.nb(i).some(m => this.land[m] && this.owner[m] === p.idx));
    if (!route) return this.msg(p, 'You can\'t reach that land yet. Expand toward it, or take some coast so boats can sail there.', 'error');
    const wp = this.smooth(route); // from our coast to the beach
    const [lx, ly] = tileXY(land); wp.push([lx, ly]);
    p.troops -= troops;
    this.boats.push({ id: this.nextId++, owner: p.idx, troops, wp, wi: 0, x: wp[0][0], y: wp[0][1], ang: 0, land, focus: tile });
    this.msg(p, 'Troops are sailing out!', 'info');
  }

  stepBoats() {
    for (const b of this.boats) {
      const p = this.players[b.owner];
      if (!p.alive) { b.done = true; continue; }
      if (this.advance(b, ECON.boatSpeed + LS.port.boatSpeed[this.levelOf(p, 'port')])) {
        b.done = true;
        const tgt = this.owner[b.land];
        if (tgt === b.owner) { p.troops += b.troops; continue; }
        if (this.fallout[b.land]) { this.msg(p, 'Your boat turned back: the beach was covered in fallout.'); p.troops += b.troops * 0.5; continue; }
        let cost = ECON.neutralCost;
        if (tgt >= 0) { const e = this.players[tgt]; cost = Math.max(2, e.troops / Math.max(1, e.tiles.length)) * 1.1 * this.defenseMult(b.land, tgt); }
        if (b.troops < cost) { this.msg(p, 'Your landing force was wiped out on the beach.', 'error'); continue; }
        b.troops -= cost; this.setOwner(b.land, b.owner);
        const ft = this.owner[b.focus] === b.owner ? b.land : b.focus;
        const t2 = this.owner[ft] === b.owner ? tgt : this.owner[ft];
        if (t2 === b.owner) { p.troops += b.troops; continue; }
        const region = this.regionReach(p, ft, t2);
        this.startAttack(p, t2, b.troops, ft, region);
      }
    }
    this.boats = this.boats.filter(b => !b.done);
  }

  doBuild(p, what, tile) {
    if (tile < 0 || tile >= N) return;
    if (what === 'ship') return this.buildShip(p, tile);
    const def = BUILDINGS[what]; if (!def) return;
    if (this.owner[tile] !== p.idx) return this.msg(p, 'You can only build on your own land.', 'error');
    if (def.coastal && !this.coastal[tile]) return this.msg(p, 'Ports must be built on the coast.', 'error');
    const [x, y] = tileXY(tile);
    if (this.buildings.some(b => Math.abs(b.x - x) <= 2 && Math.abs(b.y - y) <= 2)) return this.msg(p, 'Too close to another building.', 'error');
    const cost = this.buildCost(p, what);
    if (p.money < cost) return this.msg(p, `You need $${cost.toLocaleString()} for a ${def.name}.`, 'error');
    p.money -= cost;
    const b = { id: this.nextId++, type: what, owner: p.idx, tile, x, y, level: 1, hp: BUILDING_HP[1], cd: 0, disabled: 0 };
    this.buildings.push(b); this.buildingAt.set(tile, b); this.buildingsDirty = true; this.supplyDirty = true;
  }

  buildShip(p, tile) {
    const [x, y] = tileXY(tile);
    let port = null, bd = Infinity;
    for (const b of this.buildings) if (b.owner === p.idx && b.type === 'port') { const d = dist2(x, y, b.x, b.y); if (d < bd) { bd = d; port = b; } }
    if (!port || bd > 15 * 15) return this.msg(p, 'Battleships are built at your ports. Tap near one of your ports.', 'error');
    const water = this.nb(port.tile).find(n => !this.land[n]);
    if (water === undefined) return;
    const cost = this.buildCost(p, 'ship');
    if (p.money < cost) return this.msg(p, `You need $${cost.toLocaleString()} for a Battleship.`, 'error');
    p.money -= cost;
    const [sx, sy] = tileXY(water);
    this.ships.push({ id: this.nextId++, owner: p.idx, x: sx, y: sy, tile: water, wp: [], wi: 0, ang: 0, level: 1, hp: LS.ship.hp[1], cd: 0 });
  }

  doUpgrade(p, id) {
    const b = this.buildings.find(o => o.id === id) || this.ships.find(o => o.id === id);
    if (!b || b.owner !== p.idx || b.type === 'capital') return;
    if (b.level >= 3) return this.msg(p, 'Already at max level.', 'error');
    const type = b.type || 'ship';
    const cost = this.upgradeCost(type, b.level + 1);
    if (p.money < cost) return this.msg(p, `You need $${cost.toLocaleString()} to upgrade.`, 'error');
    p.money -= cost; b.level++; this.supplyDirty = true;
    if (type === 'ship') b.hp = LS.ship.hp[b.level]; else b.hp = BUILDING_HP[b.level];
    this.buildingsDirty = true;
  }

  doMoveShip(p, id, tile) {
    const s = this.ships.find(o => o.id === id); if (!s || s.owner !== p.idx || tile < 0 || tile >= N) return;
    if (this.land[tile]) { const w = this.nb(tile).find(n => !this.land[n]); if (w === undefined) return; tile = w; }
    const route = this.waterRoute([tile], (i) => i === s.tile);
    if (!route) return this.msg(p, 'Your ship can\'t sail there.', 'error');
    s.wp = this.smooth(route); s.wp[0] = [s.x, s.y]; s.wi = 0;
  }

  stepShips() {
    for (const s of this.ships) {
      if (!this.players[s.owner].alive) { s.dead = true; continue; }
      if (s.wp.length > 1) {
        if (this.advance(s, LS.ship.speed[s.level] * 0.5)) { s.wp = []; s.wi = 0; }
        s.tile = Math.round(s.y) * W + Math.round(s.x);
      }
      if (s.cd > 0) { s.cd--; continue; }
      const r = LS.ship.range[s.level], r2 = r * r, dmg = LS.ship.damage[s.level];
      let fired = false;
      const boat = this.boats.find(b => b.owner !== s.owner && dist2(b.x, b.y, s.x, s.y) <= r2);
      if (boat) { boat.done = true; this.boats = this.boats.filter(b => b !== boat); this.shot(s, boat.x, boat.y); this.msg(this.players[boat.owner], 'One of your boats was sunk by a battleship!', 'error'); fired = true; }
      if (!fired) {
        const ship = this.ships.find(o => o.owner !== s.owner && !o.dead && dist2(o.x, o.y, s.x, s.y) <= r2);
        if (ship) { ship.hp -= dmg; this.shot(s, ship.x, ship.y); if (ship.hp <= 0) { ship.dead = true; this.events.push({ k: 'boom', x: ship.x, y: ship.y, r: 1.5, type: 'ship' }); this.players[s.owner].kills++; } fired = true; }
      }
      if (!fired) {
        const b = this.buildings.find(o => o.owner !== s.owner && dist2(o.x, o.y, s.x, s.y) <= r2);
        if (b) { b.hp -= dmg; this.shot(s, b.x, b.y); this.buildingsDirty = true; if (b.hp <= 0) { this.events.push({ k: 'boom', x: b.x, y: b.y, r: 1.5, type: 'ship' }); this.destroyBuilding(b); } fired = true; }
      }
      if (fired) s.cd = LS.ship.cooldown[s.level];
    }
    this.ships = this.ships.filter(s => !s.dead);
  }
  shot(s, x, y) { this.events.push({ k: 'shot', x1: s.x, y1: s.y, x2: x, y2: y, o: s.owner }); }

  doBomb(p, what, tile) {
    const def = BOMBS[what]; if (!def || tile < 0 || tile >= N) return;
    const [tx, ty] = tileXY(tile);
    const silos = this.buildings.filter(b => b.owner === p.idx && b.type === 'silo');
    if (!silos.length) return this.msg(p, 'Build a Missile Silo first.', 'error');
    const able = silos.filter(b => b.level >= def.silo);
    if (!able.length) return this.msg(p, `${def.name} needs a level ${def.silo} silo.`, 'error');
    const ready = able.filter(b => b.cd <= 0 && b.disabled <= this.tick);
    if (!ready.length) return this.msg(p, 'Your silos are reloading.', 'error');
    if (p.money < def.cost) return this.msg(p, `You need $${def.cost.toLocaleString()} for the ${def.name}.`, 'error');
    let silo = ready[0];
    for (const s of ready) if (dist2(s.x, s.y, tx, ty) < dist2(silo.x, silo.y, tx, ty)) silo = s;
    p.money -= def.cost; p.bombsLaunched++;
    silo.cd = LS.silo.cooldown[silo.level];
    const d = Math.sqrt(dist2(silo.x, silo.y, tx, ty));
    const m = { id: this.nextId++, owner: p.idx, type: what, fx: silo.x, fy: silo.y, tx, ty, t: 0, dur: Math.round(25 + d / 2.5) };
    this.missiles.push(m);
    const victim = this.owner[tile];
    if (victim >= 0 && victim !== p.idx) {
      const v = this.players[victim];
      const hasRadar = this.buildings.some(b => b.owner === victim && b.type === 'radar');
      this.msg(v, hasRadar ? `Radar: ${p.country} launched a ${def.name} at you!` : `Incoming ${def.name} from ${p.country}!`, 'warn');
    }
  }

  stepMissiles() {
    const spawned = [];
    for (const m of this.missiles) {
      m.t++;
      const f = m.t / m.dur;
      const x = m.fx + (m.tx - m.fx) * f, y = m.fy + (m.ty - m.fy) * f;
      m.x = x; m.y = y;
      // interception by enemy batteries
      if (f > 0.1 && m.type !== 'emp_') {
        for (const b of this.buildings) {
          if (b.type !== 'battery' || b.owner === m.owner || b.cd > 0 || b.disabled > this.tick) continue;
          const r = LS.battery.radius[b.level];
          if (dist2(b.x, b.y, x, y) > r * r) continue;
          b.cd = LS.battery.cooldown[b.level];
          let chance = LS.battery.chance[b.level];
          for (const rd of this.buildings) if (rd.type === 'radar' && rd.owner === b.owner && rd.disabled <= this.tick && dist2(rd.x, rd.y, b.x, b.y) <= LS.radar.radius[rd.level] ** 2) chance = Math.max(chance, Math.min(0.95, chance + LS.radar.boost[rd.level]));
          if (m.type === 'bigone') chance *= 0.4;
          if (m.type === 'mini') chance *= 0.7;
          this.events.push({ k: 'icpt', bx: b.x, by: b.y, x, y, hit: false });
          if (Math.random() < chance) {
            m.dead = true; this.events[this.events.length - 1].hit = true;
            this.events.push({ k: 'boom', x, y, r: 1.2, type: 'air' });
            this.msg(this.players[m.owner], `Your ${(BOMBS[m.type] || { name: 'missile' }).name} was shot down!`, 'error');
            this.msg(this.players[b.owner], 'Your battery shot down a missile!', 'good');
            break;
          }
        }
      }
      if (m.dead) continue;
      if (m.type === 'cluster' && f >= 0.72) {
        m.dead = true;
        for (let k = 0; k < BOMBS.cluster.split; k++) {
          const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 10;
          spawned.push({ id: this.nextId++, owner: m.owner, type: 'mini', fx: x, fy: y, tx: Math.round(m.tx + Math.cos(a) * r), ty: Math.round(m.ty + Math.sin(a) * r), t: 0, dur: 12 + ((Math.random() * 8) | 0) });
        }
        continue;
      }
      if (m.t >= m.dur) { m.dead = true; this.explode(m); }
    }
    this.missiles = this.missiles.filter(m => !m.dead).concat(spawned);
  }

  explode(m) {
    const type = m.type, r = type === 'mini' ? BOMBS.cluster.radius : BOMBS[type].radius;
    const cx = m.tx, cy = m.ty;
    this.events.push({ k: 'boom', x: cx, y: cy, r, type });
    if (type === 'emp') {
      for (const b of this.buildings) if (dist2(b.x, b.y, cx, cy) <= r * r) b.disabled = this.tick + 25 * TPS;
      this.supplyDirty = true; this.empEnds = this.tick + 25 * TPS + 1;
      this.buildingsDirty = true; return;
    }
    const lost = new Map(), before = new Map();
    for (const p of this.players) before.set(p.idx, p.tiles.length);
    const fall = type === 'bigone' ? 90 * TPS : type === 'hydrogen' ? 60 * TPS : type === 'mini' ? 15 * TPS : 35 * TPS;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy; if (d2 > r * r) continue;
      const x = cx + dx, y = cy + dy; if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const i = y * W + x; if (!this.land[i]) continue;
      if (Math.random() > 1 - (d2 / (r * r)) * 0.35) continue;
      const o = this.owner[i];
      if (o >= 0) { lost.set(o, (lost.get(o) || 0) + 1); this.setOwner(i, -1); }
      this.fallout[i] = Math.max(this.fallout[i], fall);
    }
    for (const [o, n] of lost) {
      const p = this.players[o];
      p.troops = Math.max(0, p.troops - p.troops * Math.min(1, (n / Math.max(1, before.get(o))) * 1.3));
      if (o !== m.owner) this.players[m.owner].kills += n;
    }
    for (const b of [...this.buildings]) if (dist2(b.x, b.y, cx, cy) <= r * r) this.destroyBuilding(b);
    for (const s of this.ships) if (dist2(s.x, s.y, cx, cy) <= r * r) s.dead = true;
    this.ships = this.ships.filter(s => !s.dead);
    this.boats = this.boats.filter(b => dist2(b.x, b.y, cx, cy) > r * r);
  }

  economy() {
    const dt = 1 / TPS;
    const cityL = new Map();
    for (const p of this.players) { p._city = 0; p._cityG = 0; p._money = 0; }
    for (const b of this.buildings) {
      if (b.cd > 0) b.cd--;
      if (b.disabled > this.tick) continue;
      const p = this.players[b.owner];
      if (b.type === 'capital') { p._city += CAPITAL.maxTroops; p._cityG += CAPITAL.growth; p._money += CAPITAL.money; }
      else if (b.type === 'city') { p._city += LS.city.maxTroops[b.level]; p._cityG += LS.city.growth[b.level]; p._money += LS.city.money[b.level]; }
      else if (b.type === 'factory') p._money += LS.factory.money[b.level];
      else if (b.type === 'port') p._money += LS.port.money[b.level];
    }
    for (const p of this.players) {
      if (!p.alive || !p.spawned) continue;
      const t = p.tiles.length;
      if (p.tribe) { p.maxTroops = 30 + t * 5; p.growth = (0.5 + t * 0.04) * (p.troops < p.maxTroops ? 1 : 0); p.troops = Math.min(p.maxTroops, p.troops + p.growth * dt); continue; }
      p.maxTroops = ECON.baseMaxTroops + t * ECON.maxTroopsPerTile + p._city;
      const base = 3 + Math.sqrt(t) * 0.8 + p._cityG;
      const room = Math.max(0, 1 - p.troops / p.maxTroops);
      p.growth = base * 4 * room * this.settings.speed;
      p.troops = Math.min(p.maxTroops, p.troops + p.growth * dt);
      if (p.troops > p.maxTroops) p.troops -= (p.troops - p.maxTroops) * 0.02;
      p.income = (ECON.baseMoney + t * ECON.moneyPerTile + p._money) * this.settings.speed;
      p.money += p.income * dt;
    }
    void cityL;
  }

  // ---------- tribes: small grey settlements that hold their land but are weak ----------
  spawnTribe() {
    if (this.players.filter(p => p.tribe && p.alive).length >= 14) return;
    for (let k = 0; k < 300; k++) {
      const c = (Math.random() * N) | 0, cy = (c / W) | 0;
      if (!this.land[c] || this.owner[c] !== -1 || this.fallout[c] || cy < 12 || cy > H - 22) continue;
      const cx = c % W; let clear = true;
      for (let dy = -7; dy <= 7 && clear; dy++) for (let dx = -7; dx <= 7; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && x < W && y >= 0 && y < H && this.owner[y * W + x] !== -1) { clear = false; break; } }
      if (!clear) continue;
      // grow a blob of neutral land
      const size = 14 + ((Math.random() * 30) | 0), blob = [c], seen = new Set([c]);
      for (let h = 0; h < blob.length && blob.length < size; h++) for (const n of this.nb(blob[h])) if (!seen.has(n) && this.land[n] && this.owner[n] === -1 && !this.fallout[n] && Math.random() < 0.8) { seen.add(n); blob.push(n); if (blob.length >= size) break; }
      if (blob.length < 8) continue;
      const idx = this.players.length;
      const name = TRIBE_A[(Math.random() * TRIBE_A.length) | 0] + ' ' + TRIBE_B[(Math.random() * TRIBE_B.length) | 0];
      const shade = 120 + ((Math.random() * 50) | 0);
      const t = { idx, id: 'tribe' + idx, name, country: name, color: `#${shade.toString(16)}${shade.toString(16)}${(shade + 8).toString(16)}`, isBot: true, tribe: true,
        troops: blob.length * 4, money: 0, tiles: [], sx: 0, sy: 0, alive: true, spawned: true, maxTroops: 0, growth: 0, income: 0, kills: 0, bombsLaunched: 0, peakTiles: 0, eliminatedAt: 0, botState: {} };
      this.players.push(t); this.supply.push(new Uint8Array(N));
      for (const i of blob) this.setOwner(i, idx);
      this.infoDirty = true;
      return t;
    }
  }
  tribeThink(t) {
    // fight back at whoever is attacking us, a little
    if (this.tick % 15 !== t.idx % 15) return;
    const atk = this.attacks.find(a => a.t === t.idx && a.a !== t.idx);
    if (atk && t.troops > 15 && Math.random() < 0.5) {
      const edge = t.tiles.find(i => this.nb(i).some(n => this.owner[n] === atk.a));
      if (edge !== undefined) { const tile = this.nb(edge).find(n => this.owner[n] === atk.a); this.handle(t.id, { type: 'attack', tile, ratio: 0.6 }); }
    }
  }

  eliminate(p) {
    if (!p.alive) return;
    for (const t of [...p.tiles]) this.setOwner(t, -1);
    p.alive = false; p.eliminatedAt = this.tick;
    this.buildings = this.buildings.filter(b => b.owner !== p.idx); this.buildingAt = new Map(this.buildings.map(b => [b.tile, b]));
    this.buildingsDirty = true; this.infoDirty = true;
    if (!p.tribe) this.events.push({ k: 'msg', text: `${p.country} has fallen!`, kind: 'warn' });
  }

  checkEnd() {
    for (const p of this.players) if (p.alive && p.spawned && p.tiles.length === 0 && !this.boats.some(b => b.owner === p.idx)) this.eliminate(p);
    const alive = this.players.filter(p => p.alive && !p.tribe);
    let win = null;
    for (const p of alive) if (p.tiles.length >= this.landCount * this.settings.winPercent / 100) win = p;
    if (!win && alive.length === 1 && this.players.length > 1) win = alive[0];
    if (!win && alive.length === 0) win = this.players[0];
    if (win) {
      this.phase = 'over'; this.winner = win.idx;
      const ranking = this.players.filter(p => !p.tribe).sort((a, b) => (b === win) - (a === win) || (b.alive - a.alive) || b.tiles.length - a.tiles.length || b.eliminatedAt - a.eliminatedAt)
        .map(p => ({ idx: p.idx, name: p.name, country: p.country, tiles: p.tiles.length, peak: p.peakTiles, kills: p.kills, bombs: p.bombsLaunched }));
      this.events.push({ k: 'over', winner: win.idx, ranking });
    }
  }

  step() {
    this.tick++;
    if (this.phase === 'spawn') {
      const humans = this.players.filter(p => !p.isBot && !p.tribe);
      if (this.tick >= this.spawnEnd || (this.tick > 3 * TPS && humans.every(p => p.spawned))) {
        for (const p of this.players) if (!p.spawned) this.randomSpawn(p);
        this.phase = 'play'; this.playStart = this.tick;
        this.events.push({ k: 'msg', text: 'The war has begun! Tap land next to you to expand.', kind: 'good' });
      }
    } else if (this.phase === 'play') {
      for (let i = 0; i < N; i++) if (this.fallout[i]) this.fallout[i]--;
      if (this.empEnds === this.tick) this.supplyDirty = true;
      this.refreshSupply();
      this.economy();
      for (const p of this.players) if (p.alive && p.isBot) { if (p.tribe) this.tribeThink(p); else botThink(this, p); }
      if (this.settings.tribes && this.tick >= this.nextTribeAt) { this.nextTribeAt = this.tick + (35 + Math.random() * 40) * TPS; if (this.playStart !== this.tick) this.spawnTribe(); }
      this.stepAttacks();
      this.stepBoats();
      this.stepShips();
      this.stepMissiles();
      this.checkEnd();
    }
    return this.makePatch();
  }

  playerStats() {
    return this.players.map(p => ({
      troops: Math.floor(p.troops), max: Math.floor(p.maxTroops), money: Math.floor(p.money), tiles: p.tiles.length, alive: p.alive,
      cx: p.tiles.length ? +(p.sx / p.tiles.length).toFixed(1) : -1, cy: p.tiles.length ? +(p.sy / p.tiles.length).toFixed(1) : -1,
      inc: +p.income.toFixed(1), gr: Math.round(p.growth),
      out: Math.floor(this.attacks.filter(a => a.a === p.idx).reduce((s, a) => s + a.troops, 0) + this.boats.filter(b => b.owner === p.idx).reduce((s, b) => s + b.troops, 0)),
    }));
  }
  playerInfo() { return this.players.map(p => ({ idx: p.idx, id: p.id, name: p.name, country: p.country, color: p.color, isBot: p.isBot, tribe: !!p.tribe })); }
  buildingList() { return this.buildings.map(b => ({ id: b.id, type: b.type, owner: b.owner, x: b.x, y: b.y, level: b.level, hp: b.hp, dis: b.disabled > this.tick ? 1 : 0 })); }

  makePatch() {
    const patch = {
      tick: this.tick, phase: this.phase, spawnLeft: this.phase === 'spawn' ? Math.max(0, Math.ceil((this.spawnEnd - this.tick) / TPS)) : 0,
      ch: this.changes, ps: this.playerStats(),
      boats: this.boats.map(b => ({ id: b.id, o: b.owner, x: +b.x.toFixed(2), y: +b.y.toFixed(2), a: +b.ang.toFixed(2), n: Math.floor(b.troops) })),
      ms: this.missiles.map(m => ({ id: m.id, o: m.owner, type: m.type, fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty, p: +(m.t / m.dur).toFixed(3) })),
      ships: this.ships.map(s => ({ id: s.id, o: s.owner, x: +s.x.toFixed(2), y: +s.y.toFixed(2), a: +s.ang.toFixed(2), level: s.level, hp: s.hp, moving: s.wp.length > 1 })),
      ev: this.events,
      atk: this.attacks.map(a => ({ a: a.a, t: a.t, n: Math.floor(a.troops) })),
    };
    if (this.buildingsDirty) { patch.bl = this.buildingList(); this.buildingsDirty = false; }
    if (this.infoDirty) { patch.pi = this.playerInfo(); this.infoDirty = false; }
    this.changes = []; this.events = [];
    return patch;
  }

  // Full state for a client that joins or reconnects mid-game.
  snapshot() {
    const own = []; for (let i = 0; i < N; i++) if (this.owner[i] >= 0) own.push(i, this.owner[i]);
    const fo = []; for (let i = 0; i < N; i++) if (this.fallout[i]) fo.push(i, this.fallout[i]);
    return { pi: this.playerInfo(), own, fo, bl: this.buildingList(), phase: this.phase, tick: this.tick, settings: this.settings };
  }
}

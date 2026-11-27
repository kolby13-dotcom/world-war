// Simple computer players so practice games and small lobbies stay lively.
import { MAP_W as W } from './map.js';
import { BOMBS } from './rules.js';

const TPS = 10;

function sampleBorder(g, p, n) {
  const neutral = [], enemies = new Map();
  if (!p.tiles.length) return { neutral, enemies, coast: [] };
  const coast = [];
  for (let k = 0; k < n; k++) {
    const i = p.tiles[(Math.random() * p.tiles.length) | 0];
    if (g.coastal[i]) coast.push(i);
    for (const m of g.nb(i)) {
      if (!g.land[m] || g.fallout[m]) continue;
      const o = g.owner[m];
      if (o === -1) neutral.push(m);
      else if (o !== p.idx && !g.allied(o, p.idx)) { if (!enemies.has(o)) enemies.set(o, []); enemies.get(o).push(m); }
    }
  }
  return { neutral, enemies, coast };
}

// Diplomacy: answer alliance requests, sue for peace when losing, help or betray allies.
function diplomacy(g, p, s, D, enemies) {
  const power = (q) => q.troops + q.tiles.length * 3;
  if (s.reqs && s.reqs.length) {
    for (const r of s.reqs.filter(r => r.at <= g.tick)) {
      const f = g.players[r.from]; if (!f || !f.alive) continue;
      let chance = D.accept;
      if (g.attacks.some(a => a.t === p.idx && a.a !== r.from)) chance += 0.25;      // we need friends
      if (power(f) > power(p) * 1.3) chance += 0.25;                                 // they're scary
      if (g.attacks.some(a => a.a === p.idx && a.t === r.from) && power(p) > power(f) * 1.5) chance -= 0.4; // we're winning
      if (g.alliesOf(p.idx).length >= 2) chance -= 0.3;
      g.answerAlliance(p, r.from, Math.random() < chance);
    }
    s.reqs = s.reqs.filter(r => r.at > g.tick);
  }
  const incoming = g.attacks.filter(a => a.t === p.idx && !g.players[a.a].tribe);
  // losing badly: ask the attacker for peace
  for (const a of incoming) {
    const e = g.players[a.a];
    if (a.troops > p.troops * 0.8 && power(e) > power(p) * 1.4 && Math.random() < 0.08 && !g.requests.has(p.idx + '>' + a.a)) { g.requestAlliance(p, a.a); return true; }
  }
  // now and then, look for a friend among similar-sized neighbours
  if (Math.random() < 0.01 && g.alliesOf(p.idx).length < 2) {
    const cands = [...enemies.keys()].filter(o => !g.players[o].tribe && !g.requests.has(p.idx + '>' + o));
    const o = cands[(Math.random() * cands.length) | 0];
    if (o !== undefined) { const f = g.players[o]; if (power(f) > power(p) * 0.6 && power(f) < power(p) * 1.6) { g.requestAlliance(p, o); return true; } }
  }
  for (const al of g.alliesOf(p.idx)) {
    const a = g.players[al];
    // help an ally under attack
    if (D.fight > 0.5 && g.attacks.some(x => x.t === al) && p.troops > p.maxTroops * 0.6 && Math.random() < 0.15) { g.giveTroops(p, al, 0.15); return true; }
    // betrayal: an ally right next door that has grown weak
    if (Math.random() < D.betray && power(p) > power(a) * 2 && g.players[al].tiles.some(i => g.nb(i).some(n => g.owner[n] === p.idx))) {
      g.betray(p, al);
      const edge = a.tiles.find(i => g.nb(i).some(n => g.owner[n] === p.idx));
      if (edge !== undefined) g.handle(p.id, { type: 'attack', tile: edge, ratio: 0.6 });
      return true;
    }
  }
  return false;
}

export function botThink(g, p) {
  const s = p.botState, D = g.diff;
  if (s.next === undefined) { s.next = g.tick + 5 + ((Math.random() * 20) | 0); s.aggr = Math.min(1, (0.4 + Math.random() * 0.5) * D.aggr); }
  if (g.tick < s.next) return;
  s.next = g.tick + Math.round((8 + Math.random() * 18) * D.think);
  const minutes = (g.tick - (g.playStart || 0)) / TPS / 60;
  const { neutral, enemies, coast } = sampleBorder(g, p, 80);
  if (diplomacy(g, p, s, D, enemies)) return;

  // --- fight back against incoming attacks ---
  const incoming = g.attacks.filter(a => a.t === p.idx);
  if (incoming.length && p.troops > 200) {
    const atk = incoming.sort((a, b) => b.troops - a.troops)[0];
    const theirs = enemies.get(atk.a);
    if (theirs && theirs.length && Math.random() < D.fight) {
      g.handle(p.id, { type: 'attack', tile: theirs[(Math.random() * theirs.length) | 0], ratio: Math.min(0.7, (0.35 + atk.troops / Math.max(1, p.troops) * 0.6) * (0.6 + D.fight * 0.4)) });
      return;
    }
  }

  // --- expand / attack ---
  const ratio = p.troops / Math.max(1, p.maxTroops);
  if (ratio > 0.35 || p.troops > 1500 + p.tiles.length * 2) {
    let acted = false;
    if (neutral.length && (Math.random() < 0.8 || !enemies.size)) {
      g.handle(p.id, { type: 'attack', tile: neutral[(Math.random() * neutral.length) | 0], ratio: 0.3 });
      acted = true;
    }
    if (!acted && enemies.size && (ratio > 0.5 || p.troops > 3000 + p.tiles.length * 3)) {
      let best = null, bd = Infinity;
      // go for whoever is cheapest to beat outright: small, weak countries get finished off
      let finish = false;
      for (const [o, tiles] of enemies) {
        const e = g.players[o]; const d = e.troops / Math.max(1, e.tiles.length);
        const total = e.troops + e.tiles.length * Math.max(3, d * 1.3);
        if (total < bd) { bd = total; best = tiles; finish = total < p.troops * 0.5; }
      }
      const myD = p.troops / Math.max(1, p.tiles.length);
      const theirs = best && g.players[g.owner[best[0]]], theirD = theirs ? theirs.troops / Math.max(1, theirs.tiles.length) : 0;
      if (best && (finish || myD > theirD * (1.4 - s.aggr) || Math.random() < 0.1 * s.aggr)) {
        g.handle(p.id, { type: 'attack', tile: best[(Math.random() * best.length) | 0], ratio: finish ? 0.6 : 0.4 + 0.2 * s.aggr });
        acted = true;
      }
    }
    if (!acted && !neutral.length && coast.length && Math.random() < 0.3) {
      // look across the water for empty land
      for (let k = 0; k < 40; k++) {
        const i = (Math.random() * g.land.length) | 0;
        if (g.land[i] && g.owner[i] === -1 && !g.fallout[i]) {
          const dx = (i % W) - p.sx / p.tiles.length, dy = ((i / W) | 0) - p.sy / p.tiles.length;
          if (dx * dx + dy * dy < 80 * 80) { g.handle(p.id, { type: 'attack', tile: i, ratio: 0.25 }); break; }
        }
      }
    }
  }

  // --- build ---
  if (p.tiles.length < 10) return;
  const mineCount = g.buildings.filter(b => b.owner === p.idx).length;
  const pick = () => p.tiles[(Math.random() * p.tiles.length) | 0];
  const cities = g.countOf(p, 'city'), facs = g.countOf(p, 'factory');
  const want = [];
  // when we run out of land in supply range, push supply outward with a city or outpost at the frontier
  const sup2 = g.supply[p.idx];
  const outOfRange = neutral.length && !neutral.some(t => sup2[t]);
  if (outOfRange) want.push('city', 'city', 'outpost');
  if (cities < p.tiles.length / 120 + 1) want.push('city');
  if (facs < cities) want.push('factory');
  if (minutes > 1 && g.countOf(p, 'military') < 1 + p.tiles.length / 800) want.push('military');
  if (coast.length && g.countOf(p, 'port') < 1 + p.tiles.length / 600) want.push('port');
  if (minutes > 2 && g.countOf(p, 'battery') < 1 + facs / 3) want.push('battery');
  if (minutes > 3 && g.countOf(p, 'silo') < 1 + (minutes > 8 ? 1 : 0)) want.push('silo');
  if (enemies.size && g.countOf(p, 'outpost') < p.tiles.length / 300) want.push('outpost');
  const what = want[(Math.random() * want.length) | 0];
  if (what && (outOfRange || mineCount < 3 + p.tiles.length / 60) && p.money > g.buildCost(p, what)) {
    let tile = pick();
    if ((what === 'city' || what === 'outpost') && outOfRange) {
      const t = neutral[(Math.random() * neutral.length) | 0];
      // step two tiles back into our own land from the frontier
      let cur = g.nb(t).find(m => g.owner[m] === p.idx);
      for (let k = 0; k < 2 && cur !== undefined; k++) { const nx = g.nb(cur).find(m => g.owner[m] === p.idx && m !== t); if (nx !== undefined) cur = nx; }
      if (cur !== undefined) tile = cur;
    }
    if (what === 'port') tile = coast[(Math.random() * coast.length) | 0];
    if (what === 'outpost') { const all = [...enemies.values()].flat(); const t = all[(Math.random() * all.length) | 0]; const nb = g.nb(t).find(m => g.owner[m] === p.idx); if (nb !== undefined) tile = nb; }
    g.handle(p.id, { type: 'build', what, tile });
    return;
  }
  // upgrade something
  if (Math.random() < 0.3) {
    const mine = g.buildings.filter(b => b.owner === p.idx && b.level < 3 && b.type !== 'capital');
    const b = mine[(Math.random() * mine.length) | 0];
    if (b && p.money > g.upgradeCost(b.type, b.level + 1) * 1.3) { g.handle(p.id, { type: 'upgrade', id: b.id }); return; }
  }
  // bombs
  const silo = g.buildings.find(b => b.owner === p.idx && b.type === 'silo' && b.cd <= 0);
  if (silo && enemies.size && D.bombs && Math.random() < 0.25 * s.aggr * D.bombs) {
    const order = ['bigone', 'hydrogen', 'cluster', 'atomic'];
    const type = order.find(t => BOMBS[t].silo <= silo.level && p.money > BOMBS[t].cost * 1.2);
    if (type) {
      const foes = [...enemies.keys()].filter(o => !g.players[o].tribe);
      if (!foes.length) return;
      const foe = foes[(Math.random() * foes.length) | 0];
      const targets = g.buildings.filter(b => b.owner === foe);
      const t = targets.length ? targets[(Math.random() * targets.length) | 0] : null;
      const tile = t ? t.tile : enemies.get(foe)[0];
      g.handle(p.id, { type: 'bomb', what: type, tile });
      return;
    }
  }
  // battleship
  if (g.countOf(p, 'port') && g.ships.filter(x => x.owner === p.idx).length < 2 && p.money > g.buildCost(p, 'ship') * 1.5 && minutes > 2) {
    const port = g.buildings.find(b => b.owner === p.idx && b.type === 'port');
    g.handle(p.id, { type: 'build', what: 'ship', tile: port.tile });
  }
}

// Headless bot-vs-bot run to sanity check balance and performance.
import { Engine } from '../public/shared/engine.js';
import { COLORS } from '../public/shared/rules.js';
const n = +(process.argv[2] || 8), mins = +(process.argv[3] || 10);
const g = new Engine({ players: Array.from({ length: n }, (_, i) => ({ id: 'b' + i, name: 'Bot' + i, color: COLORS[i], isBot: true })), settings: { spawnTime: 1 } });
const t0 = Date.now(); let booms = 0, maxPatch = 0, kinds = {};
for (let t = 0; t < mins * 600 && g.phase !== 'over'; t++) {
  const p = g.step();
  for (const e of p.ev) if (e.k === 'boom') { booms++; kinds[e.type] = (kinds[e.type] || 0) + 1; }
  maxPatch = Math.max(maxPatch, JSON.stringify(p).length);
  if (t % 600 === 0) console.log('min', t / 600, g.players.map(p => `${p.tiles.length}/${Math.floor(p.troops)}/$${Math.floor(p.money)}`).join(' '));
}
console.log('ms per tick', ((Date.now() - t0) / g.tick).toFixed(2), 'phase', g.phase, 'buildings', g.buildings.length, 'ships', g.ships.length, 'booms', JSON.stringify(kinds), 'maxPatch', maxPatch);
console.log(g.players.map(p => p.name + ':' + p.tiles.length + (p.alive ? '' : '(dead)')).join(' '));

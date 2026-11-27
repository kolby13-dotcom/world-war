// Map rendering: terrain, territory pixels, and vector art for buildings and units.
import { MAP_W as W, MAP_H as H, getLand, getRegions } from '../shared/map.js';

export function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgba(r, g, b) { return (255 << 24) | (b << 16) | (g << 8) | r; }
function hash(i) { let x = (i * 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x & 1023) / 1023; }

function vnoise(x, y, scale, seed) {
  const gx = x / scale, gy = y / scale, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const h = (a, b) => hash((a * 73856093) ^ (b * 19349663) ^ (seed * 83492791));
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const top = h(x0, y0) * (1 - sx) + h(x0 + 1, y0) * sx, bot = h(x0, y0 + 1) * (1 - sx) + h(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bot * sy;
}

const ALLY_EDGE = [46, 230, 166];
const S = 4, BORDER = 2; // fine pixels per tile; border width in fine pixels
export class MapPainter {
  constructor() {
    this.land = getLand();
    this.terrain = new Uint32Array(W * H);
    this.terrainRGB = new Uint8Array(W * H * 3);
    this.buildTerrain();
    this.colors = []; // per player: {fill:[r,g,b], border:[r,g,b]}
    this.owner = null; this.fallout = new Map();
    this.initHi();
  }
  buildTerrain() {
    const land = this.land;
    // distance to coast for water shading (few BFS steps)
    const dist = new Uint8Array(W * H).fill(255); const q = [];
    for (let i = 0; i < W * H; i++) if (land[i]) { dist[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], d = dist[i]; if (d >= 12) continue; const x = i % W;
      for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (n >= 0 && n < W * H && dist[n] > d + 1) { dist[n] = d + 1; q.push(n); }
    }
    for (let i = 0; i < W * H; i++) {
      const y = (i / W) | 0, lat = 80 - (y + 0.5) * (360 / W), n = hash(i);
      let r, g, b;
      if (land[i]) {
        const x = i % W;
        const a = Math.abs(lat + (vnoise(x, y, 9, 1) - 0.5) * 10);
        // smooth latitude gradient: tropics -> temperate -> boreal -> tundra/ice
        const stops = [[0, [52, 120, 56]], [20, [96, 140, 70]], [40, [112, 150, 84]], [55, [70, 112, 78]], [64, [128, 140, 120]], [72, [225, 232, 236]]];
        let k = 0; while (k < stops.length - 2 && a > stops[k + 1][0]) k++;
        const [a0, c0] = stops[k], [a1, c1] = stops[k + 1]; const f = Math.max(0, Math.min(1, (a - a0) / (a1 - a0)));
        r = c0[0] + (c1[0] - c0[0]) * f; g = c0[1] + (c1[1] - c0[1]) * f; b = c0[2] + (c1[2] - c0[2]) * f;
        // patchy deserts in the dry belts
        const dry = Math.max(0, 1 - Math.abs(Math.abs(lat) - 25) / 13) * vnoise(x, y, 14, 2);
        const dd = Math.max(0, Math.min(1, (dry - 0.32) * 3));
        r += (205 - r) * dd; g += (182 - g) * dd; b += (125 - b) * dd;
        if (lat < -62) { r = 236; g = 240; b = 244; }
        const v = (n - 0.5) * 14 + (vnoise(x, y, 4, 3) - 0.5) * 16; r += v; g += v; b += v;
      } else {
        const d = Math.min(12, dist[i]);
        r = 40 - d * 1.5; g = 96 - d * 2.4; b = 150 - d * 2; const v = (n - 0.5) * 4; r += v; g += v; b += v;
      }
      r = Math.max(0, Math.min(255, r)) | 0; g = Math.max(0, Math.min(255, g)) | 0; b = Math.max(0, Math.min(255, b)) | 0;
      this.terrainRGB[i * 3] = r; this.terrainRGB[i * 3 + 1] = g; this.terrainRGB[i * 3 + 2] = b;
      this.terrain[i] = rgba(r, g, b);
    }
  }
  // ---- smooth drawing ----
  // The map is drawn at S pixels per tile. Each fine pixel takes the "shape" (water, open land, or a
  // country) that has the most weight among the 4 nearest tile centers, so staircases become
  // straight diagonals and lone tiles become round dots instead of squares.
  initHi() {
    const HW = W * S, HH = H * S;
    this.canvas = document.createElement('canvas'); this.canvas.width = HW; this.canvas.height = HH;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(HW, HH);
    this.px = new Uint32Array(this.img.data.buffer);
    this.key = new Int16Array(HW * HH);     // shape of each fine pixel: -2 water, -1 open land, else owner
    this.tk = new Int16Array(W * H);        // shape of each tile
    this.terrHi = new Uint8Array(HW * HH * 3);
    // where each fine offset inside a tile sits between tile centers
    this.OX = new Int8Array(S); this.FX = new Float32Array(S);
    for (let u = 0; u < S; u++) { const g = (u + 0.5) / S - 0.5; this.OX[u] = g < 0 ? -1 : 0; this.FX[u] = g < 0 ? g + 1 : g; }
    this.keyMask = new Uint8Array(W * H); this.colMask = new Uint8Array(W * H);
    // terrain: blend the nearest tiles of the same kind (land or water), plus a little fine grain
    for (let i = 0; i < W * H; i++) this.tk[i] = this.land[i] ? -1 : -2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.keysFor(x, y);
    const T = this.terrainRGB;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let v = 0; v < S; v++) for (let u = 0; u < S; u++) {
      const sx = x * S + u, sy = y * S + v, j = sy * HW + sx, k = this.key[j];
      const x0 = x + this.OX[u], y0 = y + this.OX[v], fx = this.FX[u], fy = this.FX[v];
      let r = 0, g = 0, b = 0, tw = 0;
      for (let c = 0; c < 4; c++) {
        const tx = Math.max(0, Math.min(W - 1, x0 + (c & 1))), ty = Math.max(0, Math.min(H - 1, y0 + (c >> 1))), i = ty * W + tx;
        if ((this.land[i] ? -1 : -2) !== k) continue;
        const ww = ((c & 1) ? fx : 1 - fx) * ((c >> 1) ? fy : 1 - fy) + 1e-6;
        r += T[i * 3] * ww; g += T[i * 3 + 1] * ww; b += T[i * 3 + 2] * ww; tw += ww;
      }
      if (!tw) { const i = y * W + x; r = T[i * 3]; g = T[i * 3 + 1]; b = T[i * 3 + 2]; tw = 1; }
      const n = (hash(j * 7 + 3) - 0.5) * (k === -1 ? 8 : 3);
      this.terrHi[j * 3] = Math.max(0, Math.min(255, r / tw + n)); this.terrHi[j * 3 + 1] = Math.max(0, Math.min(255, g / tw + n)); this.terrHi[j * 3 + 2] = Math.max(0, Math.min(255, b / tw + n));
    }
    // real-country outlines: where the smoothed country shape changes between land pixels
    const rid = getRegions().id;
    for (let i = 0; i < W * H; i++) this.tk[i] = this.land[i] ? (rid[i] >= 0 ? rid[i] : -3) : -2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.keysFor(x, y);
    this.regEdge = new Uint8Array(HW * HH);
    for (let sy = 0; sy < HH; sy++) for (let sx = 0; sx < HW; sx++) {
      const j = sy * HW + sx, k = this.key[j]; if (k === -2) continue;
      const kr = sx + 1 < HW ? this.key[j + 1] : k, kd = sy + 1 < HH ? this.key[j + HW] : k;
      if ((kr !== k && kr !== -2) || (kd !== k && kd !== -2)) this.regEdge[j] = 1;
    }
    for (let i = 0; i < W * H; i++) this.tk[i] = this.land[i] ? -1 : -2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.keysFor(x, y);
    this.dirtyTiles = []; this.box = null;
  }
  // shapes of the S*S fine pixels inside tile (x, y), from this.tk
  keysFor(x, y) {
    const HW = W * S, tk = this.tk, own = tk[y * W + x], key = this.key;
    for (let v = 0; v < S; v++) {
      const y0 = y + this.OX[v], fy = this.FX[v], ya = Math.max(0, y0), yb = Math.min(H - 1, y0 + 1);
      for (let u = 0; u < S; u++) {
        const x0 = x + this.OX[u], fx = this.FX[u], xa = Math.max(0, x0), xb = Math.min(W - 1, x0 + 1);
        const k0 = tk[ya * W + xa], k1 = tk[ya * W + xb], k2 = tk[yb * W + xa], k3 = tk[yb * W + xb];
        const w0 = (1 - fx) * (1 - fy), w1 = fx * (1 - fy), w2 = (1 - fx) * fy, w3 = fx * fy;
        // weight of each corner's shape; ties go to this tile's own shape
        let best = own, bw = (k0 === own ? w0 : 0) + (k1 === own ? w1 : 0) + (k2 === own ? w2 : 0) + (k3 === own ? w3 : 0) + 1e-6;
        if (k0 !== own) { const s = w0 + (k1 === k0 ? w1 : 0) + (k2 === k0 ? w2 : 0) + (k3 === k0 ? w3 : 0); if (s > bw) { bw = s; best = k0; } }
        if (k1 !== own && k1 !== k0) { const s = w1 + (k2 === k1 ? w2 : 0) + (k3 === k1 ? w3 : 0); if (s > bw) { bw = s; best = k1; } }
        if (k2 !== own && k2 !== k0 && k2 !== k1) { const s = w2 + (k3 === k2 ? w3 : 0); if (s > bw) { bw = s; best = k2; } }
        if (k3 !== own && k3 !== k0 && k3 !== k1 && k3 !== k2) { if (w3 > bw) { bw = w3; best = k3; } }
        key[(y * S + v) * HW + x * S + u] = best;
      }
    }
  }
  // colors of the S*S fine pixels inside tile (x, y)
  colorFor(x, y) {
    const HW = W * S, HH = H * S, key = this.key, B = BORDER, px = this.px, T = this.terrHi;
    const fall = this.fallout.size && this.fallout.has(y * W + x);
    for (let v = 0; v < S; v++) for (let u = 0; u < S; u++) {
      const sx = x * S + u, sy = y * S + v, j = sy * HW + sx, o = key[j];
      let r = T[j * 3], g = T[j * 3 + 1], b = T[j * 3 + 2];
      if (o >= 0) {
        let edge = false;
        for (let d = 1; d <= B && !edge; d++) {
          if ((sx - d >= 0 && key[j - d] !== o) || (sx + d < HW && key[j + d] !== o) || (sy - d >= 0 && key[j - d * HW] !== o) || (sy + d < HH && key[j + d * HW] !== o)) edge = true;
        }
        const c = edge ? this.colors[o].border : this.colors[o].fill, a = edge ? 0.9 : 0.62;
        r = r * (1 - a) + c[0] * a; g = g * (1 - a) + c[1] * a; b = b * (1 - a) + c[2] * a;
      }
      if (fall) { r = r * 0.5 + 60; g = g * 0.5 + 110; b = b * 0.4 + 20; }
      if (this.regEdge[j]) { r = r * 0.6 + 102; g = g * 0.6 + 102; b = b * 0.6 + 102; }
      px[j] = rgba(r | 0, g | 0, b | 0);
    }
  }
  tileKey(i) { if (!this.land[i]) return -2; const o = this.owner ? this.owner[i] : -1; return o >= 0 && this.colors[o] ? o : -1; }
  setPlayers(info) { this.info = info; this.colors = info.map((p, i) => { const c = hexToRgb(p.color); return { fill: c, border: this.allies?.has(i) ? ALLY_EDGE : c.map(v => (v * 0.55) | 0) }; }); }
  // allies get a bright mint edge around their land
  setAllies(allies, owner) {
    const key = [...allies].sort().join();
    if (key === this.allyKey) return; this.allyKey = key; this.allies = new Set(allies);
    if (this.info) { this.setPlayers(this.info); if (owner) this.setOwner(owner); }
  }
  setOwner(owner) {
    this.owner = owner; this.dirtyTiles.length = 0;
    for (let i = 0; i < W * H; i++) this.tk[i] = this.tileKey(i);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.keysFor(x, y);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.colorFor(x, y);
    this.box = [0, 0, W - 1, H - 1];
  }
  paint(i) { this.dirtyTiles.push(i); }
  repaintAround(i) { this.dirtyTiles.push(i); }
  flush() {
    const d = this.dirtyTiles;
    if (d.length) {
      // a tile's shape reaches fine pixels in its 8 neighbors; borders reach one tile further
      const km = this.keyMask, cm = this.colMask, keys = [], cols = [];
      let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
      for (const i of d) {
        this.tk[i] = this.tileKey(i);
        const x = i % W, y = (i / W) | 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const tx = x + dx, ty = y + dy; if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          const t = ty * W + tx;
          if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && !km[t]) { km[t] = 1; keys.push(t); }
          if (!cm[t]) { cm[t] = 1; cols.push(t); }
        }
        if (x - 2 < bx0) bx0 = x - 2; if (y - 2 < by0) by0 = y - 2; if (x + 2 > bx1) bx1 = x + 2; if (y + 2 > by1) by1 = y + 2;
      }
      d.length = 0;
      for (const t of keys) { km[t] = 0; this.keysFor(t % W, (t / W) | 0); }
      for (const t of cols) { cm[t] = 0; this.colorFor(t % W, (t / W) | 0); }
      const b = this.box; bx0 = Math.max(0, bx0); by0 = Math.max(0, by0); bx1 = Math.min(W - 1, bx1); by1 = Math.min(H - 1, by1);
      this.box = b ? [Math.min(b[0], bx0), Math.min(b[1], by0), Math.max(b[2], bx1), Math.max(b[3], by1)] : [bx0, by0, bx1, by1];
    }
    if (this.box) { const [x0, y0, x1, y1] = this.box; this.ctx.putImageData(this.img, 0, 0, x0 * S, y0 * S, (x1 - x0 + 1) * S, (y1 - y0 + 1) * S); this.box = null; }
  }
}

// ---------- vector art ----------
// Each drawer paints into a unit box centered on (0,0) spanning -1..1.
const GOLD = '#f5c542';
function base(ctx, color, shape = 'round') {
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0, 0.85, 0.95, 0.25, 0, 0, 7); ctx.fill();
  ctx.fillStyle = color; ctx.strokeStyle = '#111'; ctx.lineWidth = 0.08;
  ctx.beginPath(); if (shape === 'round') ctx.arc(0, 0, 0.95, 0, 7); else ctx.roundRect(-0.95, -0.95, 1.9, 1.9, 0.3); ctx.fill(); ctx.stroke();
}
function rect(ctx, x, y, w, h, fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); }
// Flat icon style: white shapes on the owner's colored bubble, dark cut-outs for detail,
// gold for top-level flourishes. Level 1 is a single clear silhouette; each level adds to it.
const W1 = '#ffffff', W2 = 'rgba(255,255,255,0.72)', CUT = 'rgba(10,16,32,0.55)';
function box(ctx, x, y, w, h, fill = W1, r = 0.06) { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
function poly(ctx, pts, fill = W1) { ctx.fillStyle = fill; ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill(); }
function dot(ctx, x, y, r, fill = W1) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
function windows(ctx, x0, y0, cols, rows, w = 0.1, gap = 0.2) { ctx.fillStyle = CUT; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) ctx.fillRect(x0 + c * gap, y0 + r * gap, w, w); }
function star(ctx, x, y, r) { ctx.fillStyle = GOLD; ctx.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); ctx.strokeStyle = 'rgba(60,35,0,0.7)'; ctx.lineWidth = 0.05; ctx.stroke(); ctx.fill(); }

const ART = {
  city(ctx, lv) {
    if (lv === 1) { // a single house
      poly(ctx, [[-0.6, -0.05], [0, -0.6], [0.6, -0.05]]); box(ctx, -0.45, -0.08, 0.9, 0.62, W1, 0.04);
      box(ctx, -0.1, 0.18, 0.2, 0.36, CUT, 0.03); windows(ctx, -0.33, 0.05, 1, 1, 0.14); windows(ctx, 0.19, 0.05, 1, 1, 0.14);
    } else if (lv === 2) { // a small town
      box(ctx, -0.7, -0.05, 0.42, 0.6, W2); box(ctx, -0.22, -0.55, 0.44, 1.1, W1); box(ctx, 0.28, -0.22, 0.42, 0.77, W2);
      windows(ctx, -0.13, -0.42, 2, 4, 0.08, 0.17); windows(ctx, -0.6, 0.08, 2, 2, 0.07, 0.15); windows(ctx, 0.38, -0.1, 2, 3, 0.07, 0.15);
    } else { // skyline
      box(ctx, -0.8, -0.2, 0.36, 0.75, W2); box(ctx, -0.4, -0.85, 0.38, 1.4, W1); box(ctx, 0.02, -0.6, 0.36, 1.15, W2); box(ctx, 0.42, -0.35, 0.36, 0.9, W1);
      ctx.fillStyle = W1; ctx.fillRect(-0.23, -1.05, 0.04, 0.22);
      windows(ctx, -0.32, -0.72, 2, 6, 0.08, 0.17); windows(ctx, 0.1, -0.48, 2, 5, 0.07, 0.17); star(ctx, 0.6, -0.62, 0.2);
    }
  },
  factory(ctx, lv) {
    // sawtooth hall with chimneys; more chimneys and lit windows per level
    for (let k = 0; k < lv; k++) { const x = -0.6 + k * 0.32; box(ctx, x, -0.78 + (k % 2) * 0.1, 0.16, 0.6, W2, 0.03); dot(ctx, x + 0.12, -0.92 + (k % 2) * 0.1, 0.12, 'rgba(255,255,255,0.45)'); }
    poly(ctx, [[-0.75, 0.5], [-0.75, -0.1], [-0.25, -0.4], [-0.25, -0.1], [0.25, -0.4], [0.25, -0.1], [0.75, -0.4], [0.75, 0.5]]);
    if (lv >= 2) { ctx.fillStyle = 'rgba(255,200,61,0.95)'; for (const x of [-0.55, -0.1, 0.35]) ctx.fillRect(x, 0.08, 0.2, 0.16); } else box(ctx, -0.15, 0.15, 0.3, 0.35, CUT, 0.03);
    if (lv === 3) star(ctx, 0.55, -0.72, 0.2);
  },
  port(ctx, lv) {
    // anchor, the classic harbour symbol; cranes and a lighthouse at higher levels
    ctx.strokeStyle = W1; ctx.lineCap = 'round'; ctx.lineWidth = 0.16;
    const ax = lv === 1 ? 0 : -0.22;
    ctx.beginPath(); ctx.moveTo(ax, -0.45); ctx.lineTo(ax, 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(ax, 0.05, 0.48, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax - 0.28, -0.25); ctx.lineTo(ax + 0.28, -0.25); ctx.stroke();
    ctx.lineWidth = 0.12; ctx.beginPath(); ctx.arc(ax, -0.6, 0.14, 0, 7); ctx.stroke();
    if (lv >= 2) { ctx.lineWidth = 0.1; ctx.beginPath(); ctx.moveTo(0.45, 0.5); ctx.lineTo(0.45, -0.55); ctx.lineTo(0.85, -0.55); ctx.stroke(); ctx.lineWidth = 0.05; ctx.beginPath(); ctx.moveTo(0.78, -0.55); ctx.lineTo(0.78, -0.25); ctx.stroke(); box(ctx, 0.66, -0.25, 0.24, 0.18, W2, 0.03); }
    if (lv === 3) star(ctx, -0.22, -0.95, 0.18);
    ctx.lineCap = 'butt';
  },
  outpost(ctx, lv) {
    // a shield, getting sturdier with each level
    poly(ctx, [[0, -0.8], [0.62, -0.55], [0.55, 0.15], [0, 0.72], [-0.55, 0.15], [-0.62, -0.55]], W1);
    if (lv === 1) poly(ctx, [[0, -0.55], [0.38, -0.38], [0.33, 0.08], [0, 0.45]], CUT);
    else { ctx.fillStyle = CUT; ctx.fillRect(-0.06, -0.6, 0.12, 1.15); ctx.fillRect(-0.45, -0.18, 0.9, 0.12); }
    if (lv === 3) star(ctx, 0, -0.85, 0.22);
  },
  silo(ctx, lv) {
    const rocket = (x, h, w = 0.18) => { poly(ctx, [[x - w, 0.45], [x - w, -h + 0.3], [x, -h], [x + w, -h + 0.3], [x + w, 0.45]]); poly(ctx, [[x - w, 0.2], [x - w - 0.14, 0.5], [x - w, 0.45]], W2); poly(ctx, [[x + w, 0.2], [x + w + 0.14, 0.5], [x + w, 0.45]], W2); dot(ctx, x, -h + 0.45, w * 0.45, CUT); };
    if (lv === 1) rocket(0, 0.8);
    else if (lv === 2) { rocket(-0.32, 0.7, 0.15); rocket(0.32, 0.7, 0.15); }
    else { rocket(-0.45, 0.55, 0.13); rocket(0.45, 0.55, 0.13); rocket(0, 0.9, 0.17); star(ctx, 0.62, -0.72, 0.18); }
    box(ctx, -0.7, 0.5, 1.4, 0.14, W2, 0.05);
  },
  battery(ctx, lv) {
    // a target reticle with launch tubes
    ctx.strokeStyle = W1; ctx.lineWidth = 0.12;
    ctx.beginPath(); ctx.arc(0, 0, 0.62, 0, 7); ctx.stroke();
    if (lv >= 2) { ctx.lineWidth = 0.08; ctx.beginPath(); ctx.arc(0, 0, 0.36, 0, 7); ctx.stroke(); }
    ctx.lineWidth = 0.1; for (const [a, b] of [[0, -0.85], [0, 0.85], [-0.85, 0], [0.85, 0]]) { ctx.beginPath(); ctx.moveTo(a * 0.55, b * 0.55); ctx.lineTo(a, b); ctx.stroke(); }
    dot(ctx, 0, 0, lv === 3 ? 0.16 : 0.12, lv === 3 ? GOLD : W1);
  },
  military(ctx, lv) {
    // rank chevrons: one per level, a star at level 3
    ctx.strokeStyle = W1; ctx.lineWidth = 0.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const top = lv === 1 ? -0.15 : lv === 2 ? -0.35 : -0.25;
    for (let k = 0; k < lv; k++) { const y = top + k * 0.36; ctx.beginPath(); ctx.moveTo(-0.55, y); ctx.lineTo(0, y + 0.38); ctx.lineTo(0.55, y); ctx.stroke(); }
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    if (lv === 3) star(ctx, 0, -0.68, 0.24);
  },
  radar(ctx, lv) {
    // dish on a stand with signal arcs
    box(ctx, -0.06, -0.05, 0.12, 0.55, W2, 0.03); box(ctx, -0.35, 0.45, 0.7, 0.12, W2, 0.05);
    ctx.save(); ctx.rotate(-0.5); ctx.fillStyle = W1; ctx.beginPath(); ctx.ellipse(0, -0.2, 0.5, 0.2, 0, 0, Math.PI); ctx.fill(); ctx.restore();
    ctx.strokeStyle = W1; ctx.lineWidth = 0.08; ctx.lineCap = 'round';
    for (let k = 1; k <= lv; k++) { ctx.beginPath(); ctx.arc(0.15, -0.45, 0.2 + k * 0.17, -1.4, -0.2); ctx.stroke(); }
    ctx.lineCap = 'butt';
    if (lv === 3) star(ctx, -0.6, -0.65, 0.18);
  },
};

ART.capital = (ctx) => {
  // castle keep with a gold star
  box(ctx, -0.7, -0.15, 1.4, 0.7, W1, 0.04);
  for (const x of [-0.7, -0.3, 0.1, 0.5]) box(ctx, x, -0.32, 0.2, 0.2, W1, 0.02);
  box(ctx, -0.22, -0.7, 0.44, 0.6, W1, 0.03);
  ctx.fillStyle = CUT; ctx.beginPath(); ctx.moveTo(-0.15, 0.55); ctx.lineTo(-0.15, 0.25); ctx.arc(0, 0.25, 0.15, Math.PI, 0); ctx.lineTo(0.15, 0.55); ctx.fill();
  star(ctx, 0, -0.92, 0.26);
};

// White art needs a dark enough bubble: very light player colors get deepened.
const bubbleCache = new Map();
function bubbleColor(c) {
  if (bubbleCache.has(c)) return bubbleCache.get(c);
  const [r, g, b] = hexToRgb(c), lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const k = lum > 0.62 ? 0.62 / lum : 1, out = `rgb(${(r * k) | 0},${(g * k) | 0},${(b * k) | 0})`;
  bubbleCache.set(c, out); return out;
}
// Buildings are drawn as round "pins": a colored bubble with the art inside and level pips under it.
export function drawBuilding(ctx, b, color, size, mine) {
  const cx = b.x + 0.5, cy = b.y + 0.5, r = size / 2;
  ctx.save();
  ctx.globalAlpha = b.dis ? 0.5 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.95, r * 0.7, r * 0.22, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  ctx.fillStyle = bubbleColor(color); ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, 7); ctx.fill();
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, 0, cx, cy, r);
  g.addColorStop(0, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, 7); ctx.fill();
  if (b.type === 'capital') { ctx.strokeStyle = '#ffc83d'; ctx.lineWidth = r * 0.14; ctx.beginPath(); ctx.arc(cx, cy, r * 1.02, 0, 7); ctx.stroke(); }
  ctx.translate(cx, cy); ctx.scale(r * 0.62, r * 0.62);
  ART[b.type]?.(ctx, b.level);
  ctx.restore();
  if (b.type !== 'capital') {
    const pr = r * 0.17, gap = pr * 2.6, y = cy + r + pr * 0.4;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath(); ctx.arc(cx + (k - 1) * gap, y, pr, 0, 7);
      ctx.fillStyle = k < b.level ? GOLD : 'rgba(0,0,0,0.45)'; ctx.fill();
      ctx.lineWidth = pr * 0.45; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }
  if (b.hp !== undefined && b.hp < [0, 100, 180, 300][b.level] && b.type !== 'capital') {
    const w = size, max = [0, 100, 180, 300][b.level];
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(cx - w / 2, cy - r - size * 0.22, w, size * 0.1);
    ctx.fillStyle = '#ff4d6d'; ctx.fillRect(cx - w / 2, cy - r - size * 0.22, w * Math.max(0, b.hp) / max, size * 0.1);
  }
  void mine;
}

export function drawDot(ctx, b, color, r) {
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x + 0.5, b.y + 0.5, r, 0, 7); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(b.x + 0.5, b.y + 0.5, r * 0.7, 0, 7); ctx.fill();
}

export function drawShip(ctx, s, color, size, t) {
  ctx.save(); ctx.translate(s.x + 0.5, s.y + 0.5 + Math.sin(t / 400 + s.id) * size * 0.04); ctx.scale(size / 2, size / 2);
  // soft shadow on the water
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(0, 0.42, 1.05, 0.16, 0, 0, 7); ctx.fill();
  if (Math.cos(s.a || 0) < 0) ctx.scale(-1, 1);
  const len = 0.8 + s.level * 0.12;
  // hull: player color with a white deck line
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(-len, -0.05); ctx.lineTo(len + 0.25, -0.05); ctx.lineTo(len - 0.1, 0.36); ctx.lineTo(-len + 0.12, 0.36); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-len + 0.1, 0.22, len * 2 - 0.1, 0.14);
  ctx.fillStyle = '#fff'; ctx.fillRect(-len, -0.12, len * 2 + 0.2, 0.08);
  // bridge and guns in light grey
  ctx.fillStyle = '#e8edf5'; ctx.beginPath(); ctx.roundRect(-0.28, -0.5, 0.5, 0.4, 0.06); ctx.fill();
  ctx.fillStyle = '#c3ccd8'; ctx.fillRect(-0.18, -0.68, 0.12, 0.2);
  for (let k = 0; k < s.level; k++) { const x = k % 2 ? -len + 0.3 + (k >> 1) * 0.25 : len - 0.25 - (k >> 1) * 0.25; ctx.fillStyle = '#e8edf5'; ctx.beginPath(); ctx.arc(x, -0.12, 0.13, Math.PI, 0); ctx.fill(); ctx.fillRect(x, -0.2, 0.32 * (k % 2 ? -1 : 1), 0.05); }
  if (s.level === 3) star(ctx, 0, -0.85, 0.16);
  ctx.restore();
  const hpMax = [0, 100, 170, 260][s.level];
  if (s.hp < hpMax) { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(s.x + 0.5 - size / 2, s.y - size * 0.35, size, size * 0.08); ctx.fillStyle = '#2ee6a6'; ctx.fillRect(s.x + 0.5 - size / 2, s.y - size * 0.35, size * s.hp / hpMax, size * 0.08); }
}

export function drawBoat(ctx, b, color, size, t) {
  ctx.save(); ctx.translate(b.x + 0.5, b.y + 0.5); ctx.scale(size / 2, size / 2);
  // a soft V-shaped wake behind the boat
  ctx.save(); ctx.rotate(b.a || 0);
  const wg = ctx.createLinearGradient(-0.4, 0, -2.2, 0); wg.addColorStop(0, 'rgba(255,255,255,0.5)'); wg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = wg; ctx.lineWidth = 0.1; ctx.lineCap = 'round';
  for (const k of [-1, 1]) { ctx.beginPath(); ctx.moveTo(-0.5, 0.2 + 0.08 * k); ctx.quadraticCurveTo(-1.3, 0.2 + 0.3 * k, -2.1, 0.2 + 0.55 * k); ctx.stroke(); }
  ctx.lineCap = 'butt';
  ctx.restore();
  if (Math.cos(b.a || 0) < 0) ctx.scale(-1, 1);
  ctx.translate(0, Math.sin((t || 0) / 250 + b.id) * 0.05);
  // round white hull with the owner's color band, one simple sail
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-0.75, 0.02); ctx.lineTo(0.85, 0.02); ctx.quadraticCurveTo(0.6, 0.45, 0.2, 0.45); ctx.lineTo(-0.45, 0.45); ctx.quadraticCurveTo(-0.7, 0.4, -0.75, 0.02); ctx.fill();
  ctx.fillStyle = color; ctx.fillRect(-0.7, 0.14, 1.45, 0.12);
  ctx.fillStyle = '#fff'; ctx.fillRect(-0.03, -0.95, 0.06, 0.97);
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0.06, -0.9); ctx.quadraticCurveTo(0.55, -0.45, 0.62, -0.08); ctx.lineTo(0.06, -0.08); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.moveTo(-0.06, -0.75); ctx.quadraticCurveTo(-0.4, -0.4, -0.48, -0.08); ctx.lineTo(-0.06, -0.08); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// A flying missile, pointing along its path. `s` is the size scale (world units per screen pixel times a type factor).
export function drawMissile(ctx, x, y, ang, type, color, s, t) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s);
  const flick = 0.75 + 0.25 * Math.sin(t / 35 + x * 7);
  if (type === 'emp') {
    // glowing energy orb with crackles
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 9);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(140,220,255,0.95)'); g.addColorStop(1, 'rgba(60,140,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 9 * flick + 1, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(220,245,255,0.9)'; ctx.lineWidth = 0.8;
    for (let i = 0; i < 3; i++) { const a = t / 90 + i * 2.1; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 3, Math.sin(a) * 3); ctx.lineTo(Math.cos(a + 0.4) * 6, Math.sin(a + 0.4) * 6); ctx.lineTo(Math.cos(a + 0.1) * 9, Math.sin(a + 0.1) * 9); ctx.stroke(); }
    ctx.restore(); return;
  }
  // engine flame
  const fl = (type === 'bigone' ? 14 : 10) * flick;
  const fg = ctx.createLinearGradient(-6, 0, -6 - fl, 0);
  fg.addColorStop(0, 'rgba(255,255,220,1)'); fg.addColorStop(0.35, 'rgba(255,190,60,0.95)'); fg.addColorStop(1, 'rgba(255,70,20,0)');
  ctx.fillStyle = fg; ctx.beginPath(); ctx.moveTo(-5.5, -2.2); ctx.quadraticCurveTo(-6 - fl, 0, -5.5, 2.2); ctx.closePath(); ctx.fill();
  const glow = ctx.createRadialGradient(-6, 0, 0, -6, 0, 6); glow.addColorStop(0, 'rgba(255,200,90,0.6)'); glow.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(-6, 0, 6, 0, 7); ctx.fill();
  // fins (country color)
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(-5.5, -1.8); ctx.lineTo(-7.5, -4.6); ctx.lineTo(-3, -1.8); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-5.5, 1.8); ctx.lineTo(-7.5, 4.6); ctx.lineTo(-3, 1.8); ctx.closePath(); ctx.fill(); ctx.stroke();
  // body
  const body = type === 'bigone' ? '#3a3f4b' : '#f2f4f8';
  ctx.fillStyle = body; ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(3.5, -2); ctx.quadraticCurveTo(8, -1.6, 9, 0); ctx.quadraticCurveTo(8, 1.6, 3.5, 2); ctx.lineTo(-6, 2); ctx.closePath(); ctx.fill(); ctx.stroke();
  // shading along the bottom
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(-6, 0.6, 9.5, 1.4);
  // color band and nose
  ctx.fillStyle = color; ctx.fillRect(-1.2, -2, 1.8, 4);
  ctx.fillStyle = type === 'bigone' ? '#ff3b1f' : type === 'hydrogen' ? '#ffc83d' : '#ff5a36';
  ctx.beginPath(); ctx.moveTo(5.2, -1.85); ctx.quadraticCurveTo(8, -1.5, 9, 0); ctx.quadraticCurveTo(8, 1.5, 5.2, 1.85); ctx.closePath(); ctx.fill();
  if (type === 'bigone' || type === 'hydrogen' || type === 'atomic') { // radiation mark
    ctx.fillStyle = '#ffc83d'; ctx.beginPath(); ctx.arc(-3.6, 0, 1.15, 0, 7); ctx.fill();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(-3.6, 0, 0.35, 0, 7); ctx.fill();
  }
  ctx.restore();
}

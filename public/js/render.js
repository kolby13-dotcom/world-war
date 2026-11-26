// Map rendering: terrain, territory pixels, and vector art for buildings and units.
import { MAP_W as W, MAP_H as H, getLand } from '../shared/map.js';

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

export class MapPainter {
  constructor() {
    this.land = getLand();
    this.canvas = document.createElement('canvas'); this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.px = new Uint32Array(this.img.data.buffer);
    this.terrain = new Uint32Array(W * H);
    this.terrainRGB = new Uint8Array(W * H * 3);
    this.buildTerrain();
    this.colors = []; // per player: {fill:[r,g,b], border:[r,g,b]}
    this.owner = null; this.fallout = new Map();
    this.dirty = true;
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
    this.px.set(this.terrain);
  }
  setPlayers(info) { this.colors = info.map(p => { const c = hexToRgb(p.color); return { fill: c, border: c.map(v => (v * 0.55) | 0) }; }); }
  setOwner(owner) { this.owner = owner; for (let i = 0; i < W * H; i++) this.paint(i); }
  paint(i) {
    const o = this.owner[i];
    const t = i * 3; let r = this.terrainRGB[t], g = this.terrainRGB[t + 1], b = this.terrainRGB[t + 2];
    if (o >= 0 && this.colors[o]) {
      const x = i % W; let border = false;
      if ((x > 0 && this.owner[i - 1] !== o) || (x < W - 1 && this.owner[i + 1] !== o) || (i >= W && this.owner[i - W] !== o) || (i < W * H - W && this.owner[i + W] !== o)) border = true;
      const c = border ? this.colors[o].border : this.colors[o].fill, a = border ? 0.9 : 0.62;
      r = r * (1 - a) + c[0] * a; g = g * (1 - a) + c[1] * a; b = b * (1 - a) + c[2] * a;
    }
    if (this.fallout.has(i)) { r = r * 0.5 + 60; g = g * 0.5 + 110; b = b * 0.4 + 20; }
    this.px[i] = rgba(r | 0, g | 0, b | 0);
    this.dirty = true;
  }
  repaintAround(i) {
    this.paint(i); const x = i % W;
    if (x > 0) this.paint(i - 1); if (x < W - 1) this.paint(i + 1);
    if (i >= W) this.paint(i - W); if (i < W * H - W) this.paint(i + W);
  }
  flush() { if (this.dirty) { this.ctx.putImageData(this.img, 0, 0); this.dirty = false; } }
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
function star(ctx, x, y, r) { ctx.fillStyle = GOLD; ctx.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); ctx.stroke(); }

const ART = {
  city(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    if (lv === 1) { rect(ctx, -0.55, -0.1, 0.45, 0.5, '#f4e3c1'); rect(ctx, 0.05, -0.25, 0.5, 0.65, '#e9d1a4');
      ctx.fillStyle = '#b5482e'; ctx.beginPath(); ctx.moveTo(-0.62, -0.1); ctx.lineTo(-0.33, -0.42); ctx.lineTo(-0.04, -0.1); ctx.fill(); ctx.beginPath(); ctx.moveTo(-0.02, -0.25); ctx.lineTo(0.3, -0.58); ctx.lineTo(0.62, -0.25); ctx.fill(); }
    else if (lv === 2) { rect(ctx, -0.7, -0.05, 0.4, 0.45, '#dcd6c8'); rect(ctx, -0.25, -0.6, 0.45, 1.0, '#c9d3dd'); rect(ctx, 0.28, -0.25, 0.42, 0.65, '#e2d4b8');
      ctx.fillStyle = '#ffe9a0'; for (let y = -0.5; y < 0.3; y += 0.22) for (let x = -0.18; x < 0.15; x += 0.18) ctx.fillRect(x, y, 0.1, 0.1); }
    else { rect(ctx, -0.75, -0.3, 0.35, 0.7, '#9fb4c8'); rect(ctx, -0.35, -0.85, 0.35, 1.25, '#bcd0e0'); rect(ctx, 0.05, -0.65, 0.32, 1.05, '#8ea5bb'); rect(ctx, 0.42, -0.4, 0.33, 0.8, '#a9bccc');
      ctx.strokeStyle = '#222'; ctx.beginPath(); ctx.moveTo(-0.18, -0.85); ctx.lineTo(-0.18, -1.1); ctx.stroke();
      ctx.fillStyle = '#ffe9a0'; for (let y = -0.75; y < 0.3; y += 0.2) { ctx.fillRect(-0.3, y, 0.08, 0.08); ctx.fillRect(-0.12, y, 0.08, 0.08); } star(ctx, 0.62, -0.7, 0.22); }
  },
  factory(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    const chim = lv; for (let k = 0; k < chim; k++) { const x = -0.55 + k * 0.38; rect(ctx, x, -0.75 + (k % 2) * 0.1, 0.16, 0.6, '#7d7d7d');
      ctx.fillStyle = 'rgba(220,220,220,0.75)'; ctx.beginPath(); ctx.arc(x + 0.1, -0.88 + (k % 2) * 0.1, 0.13 + lv * 0.02, 0, 7); ctx.fill(); }
    ctx.fillStyle = lv === 3 ? '#5f7f99' : '#9a6b4b'; ctx.beginPath(); ctx.moveTo(-0.75, 0.45); ctx.lineTo(-0.75, -0.15);
    for (let k = 0; k < 3; k++) { ctx.lineTo(-0.75 + (k + 1) * 0.5, -0.45); ctx.lineTo(-0.75 + (k + 1) * 0.5, -0.15); }
    ctx.lineTo(0.75, 0.45); ctx.closePath(); ctx.fill(); ctx.stroke();
    if (lv >= 2) { ctx.fillStyle = '#ffd36b'; ctx.fillRect(-0.55, 0.05, 0.2, 0.15); ctx.fillRect(-0.05, 0.05, 0.2, 0.15); ctx.fillRect(0.45, 0.05, 0.2, 0.15); }
    if (lv === 3) { ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(0.55, -0.6, 0.2, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(0.55, -0.6, 0.07, 0, 7); ctx.fill(); }
  },
  port(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    ctx.fillStyle = '#3a7bd5'; ctx.fillRect(-0.9, 0.2, 1.8, 0.5);
    rect(ctx, -0.8, 0.05, 1.1, 0.2, '#8b5a2b');
    const crane = (x, h) => { ctx.strokeStyle = '#f0a020'; ctx.lineWidth = 0.1; ctx.beginPath(); ctx.moveTo(x, 0.05); ctx.lineTo(x, -h); ctx.lineTo(x + 0.5, -h); ctx.stroke(); ctx.lineWidth = 0.04; ctx.beginPath(); ctx.moveTo(x + 0.45, -h); ctx.lineTo(x + 0.45, -h + 0.35); ctx.stroke(); ctx.strokeStyle = '#222'; ctx.lineWidth = 0.06; };
    crane(-0.5, 0.5 + lv * 0.08);
    if (lv >= 2) { rect(ctx, 0.1, -0.2, 0.25, 0.25, '#d04a3a'); rect(ctx, 0.38, -0.2, 0.25, 0.25, '#2e8b57'); }
    if (lv === 3) { crane(-0.05, 0.85); rect(ctx, 0.62, -0.75, 0.18, 0.8, '#fff'); ctx.fillStyle = '#d33'; ctx.fillRect(0.62, -0.5, 0.18, 0.12); ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(0.71, -0.82, 0.12, 0, 7); ctx.fill(); }
  },
  outpost(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    if (lv === 1) { ctx.fillStyle = '#7a8b4a'; ctx.beginPath(); ctx.moveTo(-0.6, 0.45); ctx.lineTo(0, -0.35); ctx.lineTo(0.6, 0.45); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    else if (lv === 2) { rect(ctx, -0.35, -0.5, 0.7, 0.95, '#9c9c9c'); for (let k = 0; k < 3; k++) rect(ctx, -0.35 + k * 0.27, -0.68, 0.16, 0.18, '#9c9c9c'); ctx.fillStyle = '#333'; ctx.fillRect(-0.08, -0.25, 0.16, 0.25); }
    else { rect(ctx, -0.8, -0.2, 1.6, 0.65, '#8a8a8a'); for (const x of [-0.8, 0.45]) { rect(ctx, x, -0.7, 0.35, 1.15, '#a3a3a3'); rect(ctx, x - 0.04, -0.82, 0.43, 0.14, '#777'); } ctx.fillStyle = '#333'; ctx.beginPath(); ctx.arc(0, 0.45, 0.22, Math.PI, 0); ctx.fill(); star(ctx, 0, -0.55, 0.22); }
    ctx.strokeStyle = '#222'; ctx.beginPath(); ctx.moveTo(0, lv === 1 ? -0.35 : -0.7); ctx.lineTo(0, -1.05); ctx.stroke();
    ctx.fillStyle = '#e33'; ctx.beginPath(); ctx.moveTo(0, -1.05); ctx.lineTo(0.35, -0.95); ctx.lineTo(0, -0.85); ctx.fill();
  },
  silo(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    const hatch = (x, r) => { ctx.fillStyle = '#4b5320'; ctx.beginPath(); ctx.arc(x, 0.1, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(x, 0.1, r * 0.6, 0, 7); ctx.fill(); ctx.strokeStyle = '#f5c542'; ctx.beginPath(); ctx.moveTo(x - r * 0.6, 0.1); ctx.lineTo(x + r * 0.6, 0.1); ctx.stroke(); ctx.strokeStyle = '#222'; };
    const missile = (x, h) => { ctx.fillStyle = '#eee'; ctx.beginPath(); ctx.moveTo(x - 0.12, 0.1); ctx.lineTo(x - 0.12, -h + 0.2); ctx.lineTo(x, -h); ctx.lineTo(x + 0.12, -h + 0.2); ctx.lineTo(x + 0.12, 0.1); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#d33'; ctx.beginPath(); ctx.moveTo(x - 0.12, -h + 0.2); ctx.lineTo(x, -h); ctx.lineTo(x + 0.12, -h + 0.2); ctx.fill(); };
    if (lv === 1) hatch(0, 0.55);
    else if (lv === 2) { hatch(0, 0.6); missile(0, 0.8); }
    else { hatch(-0.42, 0.42); hatch(0.42, 0.42); missile(-0.42, 0.85); missile(0.42, 0.85); ctx.fillStyle = 'rgba(255,80,40,0.5)'; ctx.beginPath(); ctx.arc(0, 0.1, 0.9, 0, 7); ctx.fill(); }
  },
  battery(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    rect(ctx, -0.6, 0.1, 1.2, 0.35, '#556b2f');
    const tubes = lv === 1 ? 1 : lv === 2 ? 2 : 4;
    ctx.save(); ctx.rotate(-0.6);
    for (let k = 0; k < tubes; k++) rect(ctx, -0.1 + (k - (tubes - 1) / 2) * 0.22, -0.75, 0.18, 0.85, '#9aa89a');
    ctx.restore();
    if (lv === 3) { ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.08; ctx.beginPath(); ctx.arc(0.5, -0.5, 0.3, Math.PI * 0.8, Math.PI * 1.9); ctx.stroke(); star(ctx, -0.6, -0.6, 0.2); }
  },
  radar(ctx, lv) {
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
    if (lv < 3) { rect(ctx, -0.08, -0.2, 0.16, 0.65, '#888'); ctx.fillStyle = '#ddd'; ctx.beginPath(); ctx.ellipse(0, -0.35, 0.35 + lv * 0.15, 0.2 + lv * 0.08, -0.4, 0, 7); ctx.fill(); ctx.stroke(); }
    else { ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.arc(0, 0.35, 0.75, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.strokeStyle = '#bbb'; for (const a of [0.3, 0.55, 0.8]) { ctx.beginPath(); ctx.arc(0, 0.35, 0.75 * a, Math.PI, 0); ctx.stroke(); } star(ctx, 0, -0.55, 0.2); }
    ctx.strokeStyle = 'rgba(80,255,120,0.8)'; ctx.lineWidth = 0.05; ctx.beginPath(); ctx.arc(0.4, -0.7, 0.18, -1, 0.2); ctx.stroke(); ctx.beginPath(); ctx.arc(0.4, -0.7, 0.3, -1, 0.2); ctx.stroke();
  },
};

ART.capital = (ctx) => {
  ctx.lineWidth = 0.06; ctx.strokeStyle = '#222';
  rect(ctx, -0.75, -0.2, 1.5, 0.65, '#e8dcc0');
  for (const x of [-0.75, -0.25, 0.25]) rect(ctx, x + 0.12, -0.35, 0.26, 0.15, '#e8dcc0');
  rect(ctx, -0.25, -0.75, 0.5, 0.6, '#f1e7cf');
  ctx.fillStyle = '#7a4b25'; ctx.beginPath(); ctx.arc(0, 0.45, 0.2, Math.PI, 0); ctx.fill();
  star(ctx, 0, -0.95, 0.28);
};

// Buildings are drawn as round "pins": a colored bubble with the art inside and level pips under it.
export function drawBuilding(ctx, b, color, size, mine) {
  const cx = b.x + 0.5, cy = b.y + 0.5, r = size / 2;
  ctx.save();
  ctx.globalAlpha = b.dis ? 0.5 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.95, r * 0.7, r * 0.22, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, 7); ctx.fill();
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
  if (Math.cos(s.a || 0) < 0) ctx.scale(-1, 1);
  const len = 0.8 + s.level * 0.15;
  ctx.fillStyle = '#5b6470'; ctx.strokeStyle = '#111'; ctx.lineWidth = 0.08;
  ctx.beginPath(); ctx.moveTo(-len, -0.1); ctx.lineTo(len + 0.2, -0.1); ctx.lineTo(len - 0.1, 0.35); ctx.lineTo(-len + 0.15, 0.35); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color; ctx.fillRect(-len, 0.12, len * 2 + 0.05, 0.1);
  rect(ctx, -0.25, -0.45, 0.5, 0.35, '#8a939e');
  for (let k = 0; k < s.level; k++) { const x = -len + 0.25 + k * (len * 2 - 0.3) / Math.max(1, s.level); ctx.fillStyle = '#3d444c'; ctx.beginPath(); ctx.arc(x, -0.15, 0.13, Math.PI, 0); ctx.fill(); ctx.fillRect(x, -0.22, 0.35, 0.05); }
  if (s.level === 3) star(ctx, 0, -0.65, 0.18);
  ctx.restore();
  const hpMax = [0, 100, 170, 260][s.level];
  if (s.hp < hpMax) { ctx.fillStyle = '#300'; ctx.fillRect(s.x + 0.5 - size / 2, s.y - size * 0.35, size, size * 0.1); ctx.fillStyle = '#3f3'; ctx.fillRect(s.x + 0.5 - size / 2, s.y - size * 0.35, size * s.hp / hpMax, size * 0.1); }
}

export function drawBoat(ctx, b, color, size, t) {
  ctx.save(); ctx.translate(b.x + 0.5, b.y + 0.5); ctx.scale(size / 2, size / 2);
  // wake behind the boat
  ctx.save(); ctx.rotate(b.a || 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.14;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(-0.6, 0.1 * s); ctx.quadraticCurveTo(-1.4, 0.45 * s, -2.2, 0.7 * s); ctx.stroke(); }
  ctx.restore();
  if (Math.cos(b.a || 0) < 0) ctx.scale(-1, 1);
  ctx.translate(0, Math.sin((t || 0) / 250 + b.id) * 0.06);
  ctx.fillStyle = '#7a4b25'; ctx.strokeStyle = '#111'; ctx.lineWidth = 0.1;
  ctx.beginPath(); ctx.moveTo(-0.75, 0); ctx.lineTo(0.85, 0); ctx.lineTo(0.5, 0.4); ctx.lineTo(-0.55, 0.4); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#3a2410'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -1); ctx.stroke();
  ctx.fillStyle = color; ctx.strokeStyle = '#111'; ctx.beginPath(); ctx.moveTo(0.05, -0.95); ctx.quadraticCurveTo(0.7, -0.5, 0.05, -0.1); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-0.05, -0.85); ctx.quadraticCurveTo(-0.55, -0.45, -0.05, -0.15); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

import { MAP_W, MAP_H, MAP_RLE, MAP_FIRST, MAP_LAT_TOP, MAP_STEP } from './mapdata.js';
export { MAP_W, MAP_H, MAP_LAT_TOP, MAP_STEP };
let cached = null;
export function getLand() {
  if (cached) return cached;
  const land = new Uint8Array(MAP_W * MAP_H);
  let i = 0, v = MAP_FIRST;
  for (const run of MAP_RLE) { if (v) land.fill(1, i, i + run); i += run; v ^= 1; }
  cleanSpecks(land, 1, 4);  // drop islands smaller than 4 tiles: they read as stray pixels
  cleanSpecks(land, 0, 4);  // fill in tiny lakes the same way
  cached = land;
  return land;
}

// Flip every 4-connected patch of `value` smaller than `min` tiles to the other value.
function cleanSpecks(land, value, min) {
  const N = MAP_W * MAP_H, seen = new Uint8Array(N), q = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || land[i] !== value) continue;
    q.length = 0; q.push(i); seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % MAP_W;
      if (x > 0 && !seen[c - 1] && land[c - 1] === value) { seen[c - 1] = 1; q.push(c - 1); }
      if (x < MAP_W - 1 && !seen[c + 1] && land[c + 1] === value) { seen[c + 1] = 1; q.push(c + 1); }
      if (c >= MAP_W && !seen[c - MAP_W] && land[c - MAP_W] === value) { seen[c - MAP_W] = 1; q.push(c - MAP_W); }
      if (c < N - MAP_W && !seen[c + MAP_W] && land[c + MAP_W] === value) { seen[c + MAP_W] = 1; q.push(c + MAP_W); }
    }
    if (q.length < min) for (const c of q) land[c] = value ^ 1;
  }
}


// Real-world countries ("regions"): holding every tile of one pays a steady bonus.
import { REGION_NAMES, REGION_RLE } from './regiondata.js';
let regCache = null;
export function getRegions() {
  if (regCache) return regCache;
  const N = MAP_W * MAP_H, id = new Int16Array(N);
  let i = 0;
  for (let k = 0; k < REGION_RLE.length; k += 2) { id.fill(REGION_RLE[k], i, i + REGION_RLE[k + 1]); i += REGION_RLE[k + 1]; }
  const land = getLand();
  for (let t = 0; t < N; t++) if (!land[t]) id[t] = -1;
  const n = REGION_NAMES.length, size = new Int32Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
  for (let t = 0; t < N; t++) { const r = id[t]; if (r < 0) continue; size[r]++; sx[r] += t % MAP_W; sy[r] += (t / MAP_W) | 0; }
  const list = REGION_NAMES.map((name, r) => {
    // label spot: the region's tile closest to its average position
    const ax = sx[r] / Math.max(1, size[r]), ay = sy[r] / Math.max(1, size[r]);
    return { name, size: size[r], bonus: Math.round(2 + Math.sqrt(size[r]) / 4), ax, ay, cx: ax, cy: ay };
  });
  const bd = new Float64Array(n).fill(Infinity);
  for (let t = 0; t < N; t++) { const r = id[t]; if (r < 0) continue; const x = t % MAP_W, y = (t / MAP_W) | 0, d = (x - list[r].ax) ** 2 + (y - list[r].ay) ** 2; if (d < bd[r]) { bd[r] = d; list[r].cx = x; list[r].cy = y; } }
  regCache = { id, list };
  return regCache;
}

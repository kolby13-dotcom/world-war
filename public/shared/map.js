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

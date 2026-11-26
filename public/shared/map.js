import { MAP_W, MAP_H, MAP_RLE, MAP_FIRST, MAP_LAT_TOP, MAP_STEP } from './mapdata.js';
export { MAP_W, MAP_H, MAP_LAT_TOP, MAP_STEP };
let cached = null;
export function getLand() {
  if (cached) return cached;
  const land = new Uint8Array(MAP_W * MAP_H);
  let i = 0, v = MAP_FIRST;
  for (const run of MAP_RLE) { if (v) land.fill(1, i, i + run); i += run; v ^= 1; }
  cached = land;
  return land;
}

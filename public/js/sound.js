// Sound effects, made on the fly with Web Audio (no audio files to download).
// Every sound is short and soft; the same sound is throttled so busy fights don't turn into noise.
const KEY = 'ww_sound';
let ctx = null, master = null, noiseBuf = null;
let on = true;
try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* storage blocked */ }
const last = new Map();

function audio() {
  if (!on) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// Browsers only allow sound after a tap, so unlock on the first one.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio(), { once: true, capture: true });

function throttle(name, ms) { const now = performance.now(); if (now - (last.get(name) || 0) < ms) return false; last.set(name, now); return true; }

function tone({ f = 440, f2, type = 'sine', dur = 0.15, vol = 0.3, at = 0, attack = 0.005 }) {
  const c = audio(); if (!c) return;
  const t = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
}
function noise({ dur = 0.3, vol = 0.3, from = 2000, to = 200, q = 0.7, type = 'lowpass', at = 0, attack = 0.005 }) {
  const c = audio(); if (!c) return;
  const t = c.currentTime + at, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noiseBuf; f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}

export const sfx = {
  get on() { return on; },
  toggle() { on = !on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ } if (on) sfx.tap(); return on; },
  // claiming land: soft plucks that climb a pentatonic scale while you keep expanding
  expand(n = 1, enemy = false) {
    const now = performance.now();
    if (now - (last.get('expand') || 0) < 110) return; last.set('expand', now);
    const streak = now - (last.get('expandRun') || 0) < 900 ? (sfx._step = (sfx._step || 0) + 1) : (sfx._step = 0); last.set('expandRun', now);
    const scale = [523, 587, 659, 784, 880, 1046, 1175, 1318];
    const f = scale[streak % scale.length] * (enemy ? 0.75 : 1);
    const vol = Math.min(0.16, 0.07 + n * 0.006);
    tone({ f, f2: f * 1.02, type: 'sine', dur: 0.16, vol, attack: 0.004 });
    tone({ f: f * 2, type: 'triangle', dur: 0.07, vol: vol * 0.35, attack: 0.002 });
    if (enemy) noise({ dur: 0.06, vol: 0.06, from: 2500, to: 900, type: 'bandpass', q: 2 });
  },
  tap() { if (throttle('tap', 40)) tone({ f: 620, f2: 480, type: 'triangle', dur: 0.06, vol: 0.12 }); },
  march() { if (!throttle('march', 120)) return; noise({ dur: 0.09, vol: 0.25, from: 900, to: 300, type: 'bandpass', q: 1.5 }); noise({ dur: 0.09, vol: 0.18, from: 700, to: 250, type: 'bandpass', q: 1.5, at: 0.09 }); },
  build() { if (!throttle('build', 150)) return; tone({ f: 180, f2: 120, type: 'square', dur: 0.08, vol: 0.12 }); tone({ f: 523, type: 'triangle', dur: 0.12, vol: 0.18, at: 0.07 }); tone({ f: 784, type: 'triangle', dur: 0.18, vol: 0.16, at: 0.14 }); },
  sail() { if (!throttle('sail', 400)) return; noise({ dur: 0.6, vol: 0.12, from: 500, to: 1400, type: 'bandpass', q: 0.8, attack: 0.2 }); },
  launch() { if (!throttle('launch', 250)) return; noise({ dur: 1.1, vol: 0.28, from: 300, to: 3000, type: 'bandpass', q: 1.2, attack: 0.08 }); tone({ f: 90, f2: 60, type: 'sawtooth', dur: 0.5, vol: 0.08 }); },
  boom(r = 3, big = false) {
    if (!throttle('boom', big ? 0 : 90)) return;
    const s = Math.min(1, r / 14);
    noise({ dur: 0.5 + s * 1.6 + (big ? 1.5 : 0), vol: 0.35 + s * 0.4, from: 1200 + s * 1500, to: 40, attack: 0.004 });
    tone({ f: 110 - s * 50, f2: 30, type: 'sine', dur: 0.4 + s * 1.2 + (big ? 1 : 0), vol: 0.35 + s * 0.35 });
    if (big) noise({ dur: 2.5, vol: 0.25, from: 400, to: 30, at: 0.25, attack: 0.3 });
  },
  // a building coming down: low rumble and falling rubble
  crumble(big = false) {
    if (!throttle('crumble', big ? 0 : 200)) return;
    noise({ dur: big ? 1.8 : 0.9, vol: big ? 0.4 : 0.25, from: 600, to: 60, attack: 0.02 });
    for (let k = 0; k < (big ? 7 : 4); k++) noise({ dur: 0.08, vol: 0.12, from: 2500, to: 700, type: 'bandpass', q: 3, at: 0.15 + k * (0.09 + Math.random() * 0.08) });
    if (big) tone({ f: 70, f2: 28, type: 'sine', dur: 1.6, vol: 0.4 });
  },
  shot() { if (throttle('shot', 160)) tone({ f: 1400, f2: 300, type: 'square', dur: 0.07, vol: 0.05 }); },
  zap(hit) { if (throttle('zap', 150)) tone({ f: hit ? 1800 : 1200, f2: hit ? 600 : 900, type: 'sawtooth', dur: 0.12, vol: 0.06 }); },
  alarm() { if (!throttle('alarm', 6000)) return; for (let i = 0; i < 2; i++) { tone({ f: 660, type: 'square', dur: 0.12, vol: 0.07, at: i * 0.3 }); tone({ f: 494, type: 'square', dur: 0.12, vol: 0.07, at: i * 0.3 + 0.15 }); } },
  siren() { if (!throttle('siren', 5000)) return; tone({ f: 500, f2: 900, type: 'sawtooth', dur: 0.6, vol: 0.06 }); tone({ f: 900, f2: 500, type: 'sawtooth', dur: 0.6, vol: 0.06, at: 0.6 }); },
  good() { if (!throttle('good', 800)) return; tone({ f: 659, type: 'triangle', dur: 0.14, vol: 0.16 }); tone({ f: 988, type: 'triangle', dur: 0.25, vol: 0.14, at: 0.1 }); },
  bad() { if (throttle('bad', 800)) tone({ f: 220, f2: 160, type: 'triangle', dur: 0.25, vol: 0.14 }); },
  chime() { if (!throttle('chime', 1500)) return; [784, 988, 1175].forEach((f, i) => tone({ f, type: 'sine', dur: 0.35, vol: 0.12, at: i * 0.09 })); },
  give() { if (throttle('give', 600)) [523, 659].forEach((f, i) => tone({ f, type: 'triangle', dur: 0.18, vol: 0.12, at: i * 0.08 })); },
  betray() { if (throttle('betray', 1500)) [392, 370, 311].forEach((f, i) => tone({ f, type: 'sawtooth', dur: 0.3, vol: 0.07, at: i * 0.18 })); },
  tick(final) { tone(final ? { f: 1046, type: 'triangle', dur: 0.4, vol: 0.2 } : { f: 659, type: 'triangle', dur: 0.12, vol: 0.16 }); },
  win() { [523, 659, 784, 1046].forEach((f, i) => tone({ f, type: 'triangle', dur: i === 3 ? 0.9 : 0.2, vol: 0.18, at: i * 0.14 })); tone({ f: 784, type: 'sine', dur: 0.9, vol: 0.1, at: 0.42 }); },
  lose() { [392, 349, 311, 262].forEach((f, i) => tone({ f, type: 'triangle', dur: i === 3 ? 0.8 : 0.25, vol: 0.15, at: i * 0.22 })); },
};

// Renders the app icons and the Play Store feature graphic from tools/icon.svg.
// Run: node tools/make-icons.cjs   (uses the Playwright Chromium in this environment)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
const ICON = (size, pad) => `<html><body style="margin:0;background:#0b1020"><div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:#0b1020">
  <div style="width:${size * (1 - pad * 2)}px;height:${size * (1 - pad * 2)}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></div></body></html>`;
const FEATURE = `<html><head><link href="https://fonts.googleapis.com/css2?family=Nunito:wght@900&display=swap" rel="stylesheet"></head>
<body style="margin:0"><div style="width:1024px;height:500px;background:radial-gradient(circle at 30% 40%,#1b2550,#0b1020 70%);display:flex;align-items:center;gap:40px;padding:0 70px;box-sizing:border-box;font-family:Nunito,system-ui,sans-serif">
  <div style="width:330px;height:330px;flex:none">${svg.replace('<svg ', '<svg width="100%" height="100%" ').replace('<rect width="512" height="512" fill="url(#bg)"/>', '')}</div>
  <div style="color:#fff"><div style="font-size:84px;font-weight:900;line-height:1;white-space:nowrap">World War</div>
  <div style="font-size:30px;font-weight:900;color:#ffc83d;margin-top:14px;white-space:nowrap">Grow a country. Outlast everyone.</div>
  <div style="font-size:24px;font-weight:800;color:#9aa6c8;margin-top:14px">Real-time conquest with friends</div></div></div></body></html>`;
(async () => {
  const b = await chromium.launch();
  const shot = async (html, w, h, file) => { const p = await b.newPage({ viewport: { width: w, height: h } }); await p.setContent(html); await p.waitForTimeout(400); await p.screenshot({ path: path.join(out, file) }); await p.close(); };
  for (const s of [192, 512]) await shot(ICON(s, 0), s, s, `icon-${s}.png`);
  await shot(ICON(512, 0), 512, 512, 'maskable-512.png'); // the globe already sits inside Android's round safe zone
  await shot(ICON(180, 0), 180, 180, 'apple-touch-icon.png');
  await shot(FEATURE, 1024, 500, 'feature-graphic.png');
  await b.close();
  console.log('icons written to', out);
})();

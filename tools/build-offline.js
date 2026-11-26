// Bundles the client into one self-contained HTML file that plays offline against bots.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({ entryPoints: [path.join(root, 'public/js/app.js')], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css}</style>`);
html = html.replace('<script type="module" src="/js/app.js"></script>', () => `<script>window.WW_OFFLINE = true;</script><script>${js}</script>`);
html = html.replace(/<link rel="(modulepreload|manifest|icon|apple-touch-icon)"[^>]*>\s*/g, '');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/world-war-offline.html'), html);
console.log('wrote dist/world-war-offline.html', (html.length / 1024).toFixed(0) + ' KB');

// Variant for hosts that supply their own document skeleton (no doctype/html/head/body tags).
const frag = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?html[^>]*>\s*/gi, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<\/?body>\s*/gi, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
fs.writeFileSync(path.join(root, 'dist/world-war-embed.html'), frag);
console.log('wrote dist/world-war-embed.html');

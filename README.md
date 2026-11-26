# World War

A real-time multiplayer world-conquest game for the browser (phone and desktop).

## Run it

```bash
npm install
npm start            # http://localhost:8080
```

Set `PORT` and `DATA_DIR` (where accounts and profile pictures are saved, default `./data`) as needed.
Anyone who can reach the server can sign up, add friends, create or join lobbies and play.

`npm run build:offline` writes `dist/world-war-offline.html`, a single file that plays against bots with no server.
`npm run sim -- 8 10` runs 8 bots for 10 minutes headless to check balance.

## What's in the game

- **Accounts and profiles**: sign up / log in, profile page with a picture from the camera or photo gallery, short bio, games and wins.
- **Friends**: add by username, accept requests, see who is online, invite friends to your lobby or jump into theirs.
- **Lobbies**: 5-letter share code and invite link, open lobby browser, chat, ready checks, colour picker, kick / hand over leader,
  host settings (bot fill-ins, max players, starting money, spawn time, land % needed to win), 5 second countdown.
- **Match**: world map (Natural Earth land data) with pan and pinch/wheel zoom. Tap to pick a start zone, name your country
  (or "No thanks" for `<username>'s Country`). Tap land next to you to expand; the slider sets how many people you send.
  More people = faster. Tap a neighbour to invade. Tap land across water and troops sail there by boat.
- **Economy**: people grow toward a cap set by land and cities; money grows from land, cities, ports and (most) factories.
- **Buildings** (3 levels each, unique art per level): City, Factory, Port, Outpost, Missile Silo, Battery, Radar, plus Battleships.
- **Bombs**: Atomic Bomb, Hydrogen Bomb, Multi Missile (splits into 8), The Big One, and EMP Strike. Bigger bombs need higher silo levels.
  Batteries can shoot missiles down; radars boost them and warn you. Nukes leave temporary fallout.
- **Bots** fill empty spots and power offline practice. Leaderboard, in-game chat and emotes, results screen.

## Layout

- `server/index.js` – HTTP + WebSocket server: accounts, friends, profiles, lobbies, running matches.
- `public/shared/` – game rules, map data and the simulation engine (runs on the server, and in the browser for practice).
- `public/js/` – client: app shell (`app.js`), match view and controls (`game.js`), map and unit art (`render.js`).
- `tools/` – map rasteriser, offline bundler, headless bot simulation.

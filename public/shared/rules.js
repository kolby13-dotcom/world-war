// Game rules and balance numbers, shared by server and client.
export const TICK_MS = 100;

export const BUILDINGS = {
  city:    { name: 'City',       cost: 2500, desc: 'More people, faster growth and some money', coastal: false },
  factory: { name: 'Factory',    cost: 4000, desc: 'Makes lots of money', coastal: false },
  port:    { name: 'Port',       cost: 2000, desc: 'Faster boats, trade money, builds battleships', coastal: true },
  outpost: { name: 'Outpost',    cost: 1500, desc: 'Makes nearby land much harder to invade', coastal: false },
  military: { name: 'Military Base', cost: 3000, desc: 'Trains troops faster and houses more of them', coastal: false },
  silo:    { name: 'Missile Silo', cost: 15000, desc: 'Launches bombs. Higher levels unlock bigger bombs', coastal: false },
  battery: { name: 'Battery',    cost: 9000, desc: 'Shoots down enemy missiles in range', coastal: false },
  radar:   { name: 'Radar',      cost: 4000, desc: 'Warns you of incoming missiles and boosts nearby batteries', coastal: false },
};
// The capital is placed for free where you start. It can't be built or upgraded.
export const CAPITAL = { name: 'Capital', maxTroops: 2500, growth: 10, money: 8, supply: 16 };
export const SHIP = { name: 'Battleship', cost: 6000, desc: 'Built from a port. Sinks boats, shells the coast' };
export const UPGRADE_MULT = [0, 0, 1.5, 3]; // cost of reaching level 2 / 3 as multiple of base

export const LEVEL_STATS = {
  city:    { maxTroops: [0, 3000, 7000, 15000], growth: [0, 12, 26, 45], money: [0, 5, 10, 18], supply: [0, 12, 16, 22] },
  factory: { money: [0, 16, 36, 75] },
  port:    { money: [0, 6, 12, 20], boatSpeed: [0, 0.12, 0.24, 0.38], supply: [0, 8, 10, 13] },
  military: { growth: [0, 0.3, 0.6, 1.0], maxTroops: [0, 2000, 5000, 10000] }, // growth: extra troop growth (0.3 = +30%)
  outpost: { radius: [0, 10, 14, 18], defense: [0, 1.8, 2.6, 3.5], supply: [0, 9, 12, 16] },
  silo:    { cooldown: [0, 200, 120, 60] },               // ticks between launches
  battery: { radius: [0, 16, 22, 30], chance: [0, 0.5, 0.7, 0.85], cooldown: [0, 60, 40, 25] },
  radar:   { radius: [0, 30, 45, 60], boost: [0, 0.08, 0.12, 0.18] },
  ship:    { hp: [0, 100, 170, 260], range: [0, 8, 11, 14], damage: [0, 25, 40, 60], cooldown: [0, 15, 12, 9], speed: [0, 0.5, 0.6, 0.75] },
};
export const BUILDING_HP = [0, 100, 180, 300];

export const BOMBS = {
  emp:      { name: 'EMP Strike',    cost: 15000,  radius: 12, silo: 1, desc: 'Shuts down buildings in the area for 25s' },
  atomic:   { name: 'Atomic Bomb',   cost: 35000,  radius: 7,  silo: 1, desc: 'Wipes out a city-sized area' },
  cluster:  { name: 'Multi Missile', cost: 70000,  radius: 3.5, silo: 2, split: 8, desc: 'Splits into 8 small missiles over the target' },
  hydrogen: { name: 'Hydrogen Bomb', cost: 120000, radius: 14, silo: 2, desc: 'Huge blast, leaves fallout' },
  bigone:   { name: 'The Big One',   cost: 250000, radius: 28, silo: 3, desc: 'The biggest bomb in the game. Hard to shoot down' },
};

export const ECON = {
  startTroops: 900,
  startMoney: 1000,
  baseMaxTroops: 600,
  maxTroopsPerTile: 3,
  baseMoney: 5,
  moneyPerTile: 0.05,
  workerMoney: 0.25,      // income from people at home: workerMoney * sqrt(home troops) per second
  enclaveMax: 400,        // unclaimed pockets up to this many tiles, walled in by one country, join it
  enclaveRate: 3,         // tiles per second taken from an enemy pocket walled in by your land
  neutralCost: 4,
  outOfSupplyCost: 3,     // land beyond your supply range costs this many times more people
  outOfSupplySpeed: 0.4,  // ...and is taken this much slower
  boatSpeed: 0.42,        // tiles per tick
  counterBonus: 1.25,     // troops sent against an incoming attack count this much more
  attackSpeed: 1.6,       // overall pace of land being taken
  growthSpeed: 1.3,       // overall pace of troop growth
  militaryMaxBonus: 2,    // military bases can at most triple troop growth
  spawnRadius: 3,
  maxBoats: 4,
};

// Bot difficulty. think: ticks between decisions. eco: growth and income multiplier.
export const BOT_LEVELS = {
  easy:   { name: 'Easy',   think: 2.0, eco: 0.8,  fight: 0.35, bombs: 0,   aggr: 0.6, accept: 0.85, betray: 0 },
  medium: { name: 'Medium', think: 1.0, eco: 1.0,  fight: 0.75, bombs: 1,   aggr: 1.0, accept: 0.55, betray: 0.002 },
  hard:   { name: 'Hard',   think: 0.6, eco: 1.25, fight: 1.0,  bombs: 1.6, aggr: 1.4, accept: 0.35, betray: 0.006 },
};

export const COLORS = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#46f0f0','#f032e6','#bcf60c','#fabebe','#008080','#e6beff','#9a6324','#fffac8','#800000','#aaffc3','#808000','#ffd8b1','#000075','#808080'];

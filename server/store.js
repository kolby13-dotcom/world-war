// Where accounts, friends and profile pictures are kept.
// With DATABASE_URL set (any Postgres, e.g. a free Neon database) everything lives in the
// database and survives restarts and redeploys. Without it, files in DATA_DIR are used,
// which on hosts like Render's free plan are wiped whenever the server restarts.
import fs from 'node:fs';
import path from 'node:path';

export async function openStore({ dataDir, databaseUrl }) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
    pool.on('error', (e) => console.error('database error', e.message));
    await pool.query('CREATE TABLE IF NOT EXISTS ww_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated TIMESTAMPTZ DEFAULT now())');
    const put = (k, v) => pool.query('INSERT INTO ww_kv (k, v, updated) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()', [k, v]);
    const avCache = new Map();
    console.log('Saving accounts in the database');
    return {
      kind: 'database',
      async loadDb() { const r = await pool.query('SELECT v FROM ww_kv WHERE k = $1', ['db']); return r.rows[0] ? JSON.parse(r.rows[0].v) : null; },
      async saveDb(json) { await put('db', json); },
      async putAvatar(k, buf) { avCache.set(k, buf); await put('av:' + k, buf.toString('base64')); },
      async dropAvatar(k) { avCache.delete(k); await pool.query('DELETE FROM ww_kv WHERE k = $1', ['av:' + k]); },
      async getAvatar(k) {
        if (avCache.has(k)) return avCache.get(k);
        const r = await pool.query('SELECT v FROM ww_kv WHERE k = $1', ['av:' + k]);
        const buf = r.rows[0] ? Buffer.from(r.rows[0].v, 'base64') : null;
        if (buf) { avCache.set(k, buf); if (avCache.size > 300) avCache.delete(avCache.keys().next().value); }
        return buf;
      },
      async close() { await pool.end(); },
    };
  }
  const avDir = path.join(dataDir, 'avatars'), dbFile = path.join(dataDir, 'users.json');
  fs.mkdirSync(avDir, { recursive: true });
  console.log(`Saving accounts in ${dbFile}`);
  return {
    kind: 'files',
    async loadDb() { try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch { return null; } },
    async saveDb(json) { const tmp = dbFile + '.tmp'; await fs.promises.writeFile(tmp, json); await fs.promises.rename(tmp, dbFile); },
    async putAvatar(k, buf) { await fs.promises.writeFile(path.join(avDir, k + '.img'), buf); },
    async dropAvatar(k) { await fs.promises.rm(path.join(avDir, k + '.img'), { force: true }); },
    async getAvatar(k) { try { return await fs.promises.readFile(path.join(avDir, k + '.img')); } catch { return null; } },
    async close() {},
  };
}

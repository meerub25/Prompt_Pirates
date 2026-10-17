const express = require('express');
const { pool, waitForDb } = require('./db');
const { initSchema } = require('./schema');
const { seedBaseline, SPORT_IDS } = require('./seed');
const { fail } = require('./util');

const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.json({ limit: '1mb' }));

const DEFAULT_STOCK = { 'var-jersey-001-M': 1, 'var-jersey-001-L': 5 };

app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM sports');
    if (r.rows[0].n > 0) return res.json({ status: 'ok' });
    return res.status(503).json({ status: 'seeding' });
  } catch (e) {
    return res.status(503).json({ status: 'down' });
  }
});

app.post('/audit/v1/reset', async (req, res, next) => {
  try {
    const body = req.body || {};
    const seed = body.seed === undefined ? 42 : body.seed;
    if (!Number.isInteger(seed))
      return fail(res, 400, 'VALIDATION_ERROR', 'seed must be an integer', { fields: ['seed'] });

    let stock = { ...DEFAULT_STOCK };
    if (body.stock !== undefined) {
      if (typeof body.stock !== 'object' || body.stock === null || Array.isArray(body.stock))
        return fail(res, 400, 'VALIDATION_ERROR', 'stock must be an object', { fields: ['stock'] });
      for (const v of Object.values(body.stock)) {
        if (!Number.isInteger(v) || v < 0)
          return fail(res, 400, 'VALIDATION_ERROR', 'stock values must be integers >= 0', { fields: ['stock'] });
      }
      stock = { ...stock, ...body.stock };
    }
    await seedBaseline(seed, stock);
    res.json({
      status: 'reset_complete', seed, sports: SPORT_IDS,
      tenants: ['tenant-alpha', 'tenant-beta'], stock
    });
  } catch (e) { next(e); }
});

app.use('/audit/v1', require('./routes/sports'));
app.use('/audit/v1', require('./routes/leagues'));
app.use('/audit/v1', require('./routes/events'));
app.use('/audit/v1', require('./routes/store'));
app.get('/audit/v1/standings/:league_id', require('./routes/standings').handleStandings);
app.post('/audit/v1/offline-sync', require('./routes/offline-sync').handleOfflineSync);

const pingRequests = new Map();
app.get('/api/v1/ping', (req, res) => {
  const now = Date.now();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (pingRequests.get(clientIp) || []).filter(timestamp => now - timestamp < 10000);
  if (recent.length >= 100) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + 10000 - now) / 1000));
    pingRequests.set(clientIp, recent);
    res.set('Retry-After', String(retryAfter));
    return fail(res, 429, 'RATE_LIMITED', 'Rate limit exceeded.');
  }
  recent.push(now);
  pingRequests.set(clientIp, recent);
  return res.json({ pong: true });
});
app.use('/api/v1', require('./routes/app'));

app.use((req, res) => {
  return fail(res, 404, 'NOT_FOUND', 'The requested route does not exist.');
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large')
    return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Body exceeds 1 MB');
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError)
    return fail(res, 400, 'VALIDATION_ERROR', 'Malformed JSON', { fields: [] });
  console.error(err);
  return fail(res, 500, 'INTERNAL_ERROR', 'Unexpected error');
});

(async () => {
  await waitForDb();
  await initSchema();
  await seedBaseline(42, DEFAULT_STOCK);
  app.listen(8080, '0.0.0.0', () => console.log('API on 8080'));
})();

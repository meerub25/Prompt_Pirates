const express = require('express');
const { pool, waitForDb } = require('./db');
const { initSchema } = require('./schema');
const { seedBaseline, SPORT_IDS } = require('./seed');
const { fail } = require('./util');

const app = express();
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

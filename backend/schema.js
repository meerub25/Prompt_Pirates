const { pool } = require('./db');

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB);
    CREATE TABLE IF NOT EXISTS sports (sport_id TEXT PRIMARY KEY, config JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS tenants (tenant_id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS variants (
      variant_id TEXT PRIMARY KEY, product_id TEXT, tenant_id TEXT,
      price_minor INT NOT NULL,
      stock INT NOT NULL CHECK (stock >= 0),
      reserved INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS leagues (league_id TEXT PRIMARY KEY, config JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS matches (
      match_id TEXT PRIMARY KEY, sport_id TEXT, league_id TEXT,
      home TEXT, away TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY, match_id TEXT NOT NULL, event_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL, payload JSONB, body JSONB, signature TEXT, seq INT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      request JSONB NOT NULL,
      response JSONB NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL REFERENCES orders(order_id),
      variant_id TEXT NOT NULL REFERENCES variants(variant_id),
      quantity INT NOT NULL CHECK (quantity > 0),
      unit_price_minor INT NOT NULL CHECK (unit_price_minor >= 0),
      PRIMARY KEY (order_id, variant_id)
    );
    CREATE TABLE IF NOT EXISTS domain_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE SEQUENCE IF NOT EXISTS payment_id_seq;
  `);
}
module.exports = { initSchema };

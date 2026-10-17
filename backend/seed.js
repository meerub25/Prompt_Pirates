const { pool } = require('./db');

const SPORTS = {
  football: {
    name: 'Football', scoring_model: 'event',
    periods: { count: 2, duration_minutes: 45 },
    scoring_events: { goal: { points: 1 } },
    draw_allowed: true, overtime: { policy: 'none' },
    tie_break_order: ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'],
    roster: { min_squad_size: 11, max_squad_size: 25, required_positions: { gk: 1 } }
  },
  basketball: {
    name: 'Basketball', scoring_model: 'event',
    periods: { count: 4, duration_minutes: 12 },
    scoring_events: { free_throw: { points: 1 }, two_pointer: { points: 2 }, three_pointer: { points: 3 } },
    draw_allowed: false, overtime: { policy: 'extra_time', duration_minutes: 5 },
    tie_break_order: ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'],
    roster: { min_squad_size: 5, max_squad_size: 15, required_positions: {} }
  },
  cricket: {
    name: 'Cricket', scoring_model: 'innings',
    periods: { innings_per_team: 1, overs_per_innings: 20, balls_per_over: 6, wickets_per_innings: 10 },
    scoring_events: {
      dot_ball: { runs: 0, legal_ball: true, wicket: false },
      single: { runs: 1, legal_ball: true, wicket: false },
      two: { runs: 2, legal_ball: true, wicket: false },
      four: { runs: 4, legal_ball: true, wicket: false },
      six: { runs: 6, legal_ball: true, wicket: false },
      wide: { runs: 1, legal_ball: false, wicket: false },
      no_ball: { runs: 1, legal_ball: false, wicket: false },
      wicket: { runs: 0, legal_ball: true, wicket: true }
    },
    draw_allowed: true, overtime: { policy: 'super_over' },
    tie_break_order: ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'],
    roster: { min_squad_size: 11, max_squad_size: 18, required_positions: { wicketkeeper: 1 } }
  },
  esports: {
    name: 'Esports', scoring_model: 'round',
    periods: { best_of: 3 },
    scoring_events: { round_win: { rounds: 1 } },
    draw_allowed: false, overtime: { policy: 'none' },
    tie_break_order: ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'],
    roster: { min_squad_size: 5, max_squad_size: 8, required_positions: {} }
  }
};

async function seedBaseline(seed, stock) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE settings, sports, tenants, variants, leagues, matches, events RESTART IDENTITY');
    await c.query('INSERT INTO settings(key, value) VALUES ($1, $2)', ['lots_seed', JSON.stringify(seed)]);
    for (const [id, cfg] of Object.entries(SPORTS)) {
      await c.query('INSERT INTO sports(sport_id, config) VALUES ($1, $2)',
        [id, JSON.stringify({ sport_id: id, ...cfg })]);
    }
    await c.query(`INSERT INTO tenants(tenant_id, name) VALUES
      ('tenant-alpha', 'Alpha Sports'), ('tenant-beta', 'Beta Athletics')`);
    for (const v of ['var-jersey-001-M', 'var-jersey-001-L']) {
      await c.query(
        `INSERT INTO variants(variant_id, product_id, tenant_id, price_minor, stock, reserved)
         VALUES ($1, 'prod-jersey-001', 'tenant-alpha', 450000, $2, 0)`, [v, stock[v]]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
module.exports = { seedBaseline, SPORT_IDS: Object.keys(SPORTS) };

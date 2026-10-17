const { pool } = require('./db');
const { hashPassword } = require('./auth/password');

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
    await c.query(`TRUNCATE TABLE
      order_items, orders, domain_events,
      offline_actions, app_users, clubs,
      settings, sports, tenants, variants, leagues, matches, events
      RESTART IDENTITY CASCADE`);
    await c.query('ALTER SEQUENCE payment_id_seq RESTART WITH 1');
    await c.query('INSERT INTO settings(key, value) VALUES ($1, $2)', ['lots_seed', JSON.stringify(seed)]);
    for (const [id, cfg] of Object.entries(SPORTS)) {
      await c.query('INSERT INTO sports(sport_id, config) VALUES ($1, $2)',
        [id, JSON.stringify({ sport_id: id, ...cfg })]);
    }
    await c.query(`INSERT INTO tenants(tenant_id, name) VALUES
      ('tenant-alpha', 'Alpha Sports'), ('tenant-beta', 'Beta Athletics')`);
    const baselineLeagues = [
      ['league-alpha-1', 'tenant-alpha'],
      ['league-alpha-2', 'tenant-alpha'],
      ['league-beta-1', 'tenant-beta']
    ];
    for (const [leagueId, tenantId] of baselineLeagues) {
      await c.query(
        `INSERT INTO leagues (league_id, config)
         VALUES ($1, $2::jsonb)`,
        [
          leagueId,
          JSON.stringify({
            league_id: leagueId,
            tenant_id: tenantId,
            sport_id: 'football',
            teams: [],
            fixtures: [],
            points: { win: 3, draw: 1, loss: 0 },
            tie_break_order: SPORTS.football.tie_break_order,
            qualification: { spots: 1 },
            lots_seed: seed
          })
        ]
      );
    }
    const clubs = [
      {
        club_id: 'club-alpha-1',
        tenant_id: 'tenant-alpha',
        name: 'Alpha United',
        venue: { name: 'Alpha Sports Ground', address: 'Alpha City' },
        roster: [{ player_id: 'player-alpha-1', name: 'Ali', position: 'player' }],
        staff: [{ role: 'manager', name: 'Alpha Club Manager' }]
      },
      {
        club_id: 'club-alpha-2',
        tenant_id: 'tenant-alpha',
        name: 'Alpha Athletic',
        venue: { name: 'Alpha Athletic Arena', address: 'Alpha City' },
        roster: [{ player_id: 'player-alpha-2', name: 'Bilal', position: 'player' }],
        staff: [{ role: 'coach', name: 'Alpha Athletic Coach' }]
      },
      {
        club_id: 'club-beta-1',
        tenant_id: 'tenant-beta',
        name: 'Beta Athletics',
        venue: { name: 'Beta Sports Ground', address: 'Beta City' },
        roster: [{ player_id: 'player-beta-1', name: 'Sara', position: 'player' }],
        staff: [{ role: 'manager', name: 'Beta Club Manager' }]
      }
    ];
    for (const club of clubs) {
      await c.query(
        `INSERT INTO clubs (club_id, tenant_id, name, home_venue, roster, staff)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
        [
          club.club_id,
          club.tenant_id,
          club.name,
          JSON.stringify(club.venue),
          JSON.stringify(club.roster),
          JSON.stringify(club.staff)
        ]
      );
    }
    const demoUsers = [
      {
        email: 'admin@nascon.test',
        role: 'super_admin'
      },
      {
        email: 'organizer@nascon.test',
        role: 'league_organizer',
        tenant_id: 'tenant-alpha',
        own_league_id: 'league-alpha-1'
      },
      {
        email: 'manager@nascon.test',
        role: 'club_manager',
        tenant_id: 'tenant-alpha',
        own_club_id: 'club-alpha-1'
      },
      {
        email: 'player@nascon.test',
        role: 'player',
        tenant_id: 'tenant-alpha',
        own_club_id: 'club-alpha-1',
        own_player_id: 'player-alpha-1'
      },
      {
        email: 'viewer@nascon.test',
        role: 'viewer',
        tenant_id: 'tenant-alpha'
      }
    ];
    for (const user of demoUsers) {
      await c.query(
        `INSERT INTO app_users
          (email, password_hash, role, tenant_id, own_league_id, own_club_id, own_player_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user.email,
          hashPassword(user.email, 'Nascon@26'),
          user.role,
          user.tenant_id || null,
          user.own_league_id || null,
          user.own_club_id || null,
          user.own_player_id || null
        ]
      );
    }
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

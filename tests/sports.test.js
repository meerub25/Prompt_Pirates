const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSport } = require('../backend/logic/sports');

function kabaddi() {
  return {
    sport_id: 'kabaddi',
    name: 'Kabaddi',
    scoring_model: 'event',
    periods: { count: 2, duration_minutes: 20 },
    scoring_events: {
      raid_point: { points: 1 },
      tackle_point: { points: 1 },
      all_out: { points: 2 }
    },
    draw_allowed: false,
    overtime: { policy: 'golden_score', duration_minutes: 5 },
    tie_break_order: ['h2h_points', 'scored'],
    roster: {
      min_squad_size: 7,
      max_squad_size: 12,
      required_positions: { raider: 2, defender: 3 }
    }
  };
}

test('validates and normalizes the event-model sport configuration', () => {
  const result = validateSport(kabaddi());
  assert.deepEqual(result.fields, []);
  assert.equal(result.config.sport_id, 'kabaddi');
  assert.deepEqual(result.config.tie_break_order, [
    'h2h_points',
    'scored',
    'draw_lots'
  ]);
});

test('rejects a SQL-injection-shaped sport id as validation input', () => {
  const input = kabaddi();
  input.sport_id = "x'; DROP TABLE sports;--";
  const result = validateSport(input);
  assert.ok(result.fields.includes('sport_id'));
  assert.equal(result.config, undefined);
});

test('preserves valid event names that overlap with object prototype properties', () => {
  const input = kabaddi();
  input.scoring_events = JSON.parse('{"__proto__":{"points":1}}');
  const result = validateSport(input);
  assert.deepEqual(result.fields, []);
  assert.equal(Object.hasOwn(result.config.scoring_events, '__proto__'), true);
});

test('validates innings and round scoring rules from their model configuration', () => {
  const innings = kabaddi();
  innings.scoring_model = 'innings';
  innings.periods = {
    innings_per_team: 1,
    overs_per_innings: 10,
    balls_per_over: 6,
    wickets_per_innings: 10
  };
  innings.scoring_events = {
    super_six: { runs: 6, legal_ball: true, wicket: false },
    bye_run: { runs: 1, legal_ball: false, wicket: false }
  };
  assert.deepEqual(validateSport(innings).fields, []);

  const round = kabaddi();
  round.scoring_model = 'round';
  round.periods = { best_of: 5 };
  round.scoring_events = { map_win: { rounds: 1 } };
  assert.deepEqual(validateSport(round).fields, []);

  round.periods.best_of = 4;
  assert.ok(validateSport(round).fields.includes('periods.best_of'));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLeague } = require('../backend/logic/leagues');

function league() {
  return {
    league_id: 'lg-1',
    sport_id: 'kabaddi',
    teams: ['t1', 't2'],
    fixtures: [{ match_id: 'm1', home: 't1', away: 't2', ignored: true }],
    qualification: { spots: 1, ignored: true },
    points: { win: 3, draw: 1, loss: 0, ignored: 100 },
    ignored: true
  };
}

test('validates and normalizes a league request while ignoring unknown fields', () => {
  const result = validateLeague(league());
  assert.deepEqual(result.fields, []);
  assert.deepEqual(result.config.fixtures, [
    { match_id: 'm1', home: 't1', away: 't2' }
  ]);
  assert.deepEqual(result.config.qualification, { spots: 1 });
  assert.deepEqual(result.config.points, { win: 3, draw: 1, loss: 0 });
});

test('requires unique valid teams and fixture participants', () => {
  const input = league();
  input.teams = ['t1', 't1'];
  input.fixtures[0].away = 'outside';
  const result = validateLeague(input);
  assert.ok(result.fields.includes('teams'));
  assert.ok(result.fields.includes('fixtures.0.away'));
});

test('rejects invalid points, tie-break criteria, and qualification spots', () => {
  const input = league();
  input.points.win = 3.5;
  input.tie_break_order = ['scored', 'scored'];
  input.qualification.spots = 0;
  const result = validateLeague(input);
  assert.ok(result.fields.includes('points.win'));
  assert.ok(result.fields.includes('tie_break_order'));
  assert.ok(result.fields.includes('qualification.spots'));
});

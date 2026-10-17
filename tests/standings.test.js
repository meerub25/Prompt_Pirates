const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStandings } = require('../backend/logic/standings');

function result(matchId, homeId, awayId, homeScore, awayScore, winner) {
  return {
    match_id: matchId,
    status: 'completed',
    outcome: winner ? `${winner}_win` : 'draw',
    winner_team_id: winner === 'home' ? homeId : winner === 'away' ? awayId : null,
    home: { team_id: homeId, score: homeScore, fair_play: 0, wickets: null, balls: null },
    away: { team_id: awayId, score: awayScore, fair_play: 0, wickets: null, balls: null }
  };
}

test('builds table and complete ordered-pair head-to-head data from projections', () => {
  const league = {
    league_id: 'lg-test',
    sport_id: 'test',
    teams: ['t1', 't2', 't3'],
    fixtures: [
      { match_id: 'm1', home: 't1', away: 't2' },
      { match_id: 'm2', home: 't2', away: 't3' },
      { match_id: 'm3', home: 't3', away: 't1' }
    ],
    points: { win: 3, draw: 1, loss: 0 },
    tie_break_order: ['h2h_points', 'h2h_diff', 'overall_diff', 'scored', 'fair_play', 'draw_lots'],
    qualification: { spots: 1 },
    lots_seed: 42
  };
  const standings = buildStandings(league, [
    result('m1', 't1', 't2', 2, 0, 'home'),
    result('m2', 't2', 't3', 1, 0, 'home'),
    result('m3', 't3', 't1', 1, 0, 'home')
  ], {
    scoring_model: 'event',
    periods: {},
    tie_break_order: league.tie_break_order
  });
  assert.equal(standings.table.length, 3);
  assert.equal(standings.table[0].played, 2);
  assert.equal(standings.h2h.t1.t2.played, 1);
  assert.equal(standings.h2h.t2.t1.points, 0);
  assert.equal(standings.h2h.t1.t3.conceded, 1);
  assert.equal(standings.table[0].status, 'still_possible');
});

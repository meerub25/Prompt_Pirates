const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compensationError,
  projectScore,
  validateEvent,
  validateScoreLimit
} = require('../backend/logic/scoring');

const match = {
  match_id: 'm1',
  sport_id: 'kabaddi',
  league_id: 'lg1',
  home: 't1',
  away: 't2'
};

function scoreConfig() {
  return {
    scoring_model: 'event',
    scoring_events: { raid_point: { points: 1 }, all_out: { points: 2 } },
    draw_allowed: false,
    periods: { count: 2, duration_minutes: 20 }
  };
}

function event(event_id, type, payload, seq) {
  return { event_id, match_id: 'm1', type, payload, seq, signature: 'sig' };
}

test('validates event request shapes without relying on sport-specific names', () => {
  const valid = validateEvent({
    event_id: 'evt1',
    match_id: 'm1',
    type: 'score',
    payload: { team_id: 't1', event_type: 'raid_point' }
  });
  assert.deepEqual(valid.fields, []);

  const invalid = validateEvent({
    event_id: 'evt1',
    match_id: 'm1',
    type: 'match_init',
    payload: { sport_id: 'kabaddi', home_team_id: 't1', away_team_id: 't1' }
  });
  assert.ok(invalid.fields.includes('payload.away_team_id'));
});

test('projects status, score, fair play, version, and compensation from the event log', () => {
  const events = [
    event('init', 'match_init', {
      sport_id: 'kabaddi',
      home_team_id: 't1',
      away_team_id: 't2'
    }, 1),
    event('start', 'match_start', {}, 2),
    event('score1', 'score', { team_id: 't1', event_type: 'raid_point' }, 3),
    event('discipline1', 'discipline', { team_id: 't2', points: -1 }, 4),
    event('undo1', 'compensation', { compensates: 'score1', reason: 'Correction' }, 5),
    event('end', 'match_end', {}, 6)
  ];
  const result = projectScore(match, scoreConfig(), events);
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, 'undecided');
  assert.equal(result.winner_team_id, null);
  assert.equal(result.home.score, 0);
  assert.equal(result.away.fair_play, -1);
  assert.equal(result.version, 6);
  assert.equal(result.events[2].compensated, true);
  assert.equal(result.events[2].compensated_by, 'undo1');
});

test('rejects invalid compensation targets and permits an eligible target', () => {
  assert.equal(compensationError(null, 'm1', false), 'EVENT_NOT_FOUND');
  assert.equal(
    compensationError({ match_id: 'm1', type: 'match_start' }, 'm1', false),
    'INVALID_COMPENSATION'
  );
  assert.equal(
    compensationError({ match_id: 'm1', type: 'score' }, 'm1', true),
    'INVALID_COMPENSATION'
  );
  assert.equal(
    compensationError({ match_id: 'm1', type: 'score' }, 'm1', false),
    null
  );
});

test('counts only active innings events when enforcing legal-ball and wicket limits', () => {
  const config = {
    scoring_model: 'innings',
    periods: {
      innings_per_team: 1,
      overs_per_innings: 1,
      balls_per_over: 2,
      wickets_per_innings: 2
    },
    scoring_events: {
      ball: { runs: 1, legal_ball: true, wicket: false },
      out: { runs: 0, legal_ball: true, wicket: true }
    }
  };
  const events = [
    event('b1', 'score', { team_id: 't1', event_type: 'ball' }, 1),
    event('b2', 'score', { team_id: 't1', event_type: 'ball' }, 2)
  ];
  assert.equal(validateScoreLimit(config, 't1', events), 'INNINGS_COMPLETE');
  events.push(event('undo', 'compensation', { compensates: 'b1', reason: 'Correction' }, 3));
  assert.equal(validateScoreLimit(config, 't1', events), null);
});

test('enforces the round-model series limit and excludes compensated rounds', () => {
  const config = {
    scoring_model: 'round',
    periods: { best_of: 3 },
    scoring_events: { map_win: { rounds: 1 } }
  };
  const events = [
    event('r1', 'score', { team_id: 't1', event_type: 'map_win' }, 1),
    event('r2', 'score', { team_id: 't1', event_type: 'map_win' }, 2)
  ];
  assert.equal(validateScoreLimit(config, 't1', events), 'SERIES_ALREADY_DECIDED');
  events.push(event('undo', 'compensation', { compensates: 'r1', reason: 'Correction' }, 3));
  assert.equal(validateScoreLimit(config, 't1', events), null);
});

test('projects innings fields and rounds from configured scoring data', () => {
  const inningsConfig = {
    scoring_model: 'innings',
    scoring_events: { bye: { runs: 1, legal_ball: false, wicket: false } },
    periods: { balls_per_over: 6 },
    draw_allowed: true
  };
  const innings = projectScore(match, inningsConfig, [
    event('b', 'score', { team_id: 't1', event_type: 'bye' }, 1)
  ]);
  assert.equal(innings.home.score, 1);
  assert.equal(innings.home.balls, 0);
  assert.equal(innings.home.overs, '0.0');

  const round = projectScore(match, {
    scoring_model: 'round',
    scoring_events: { map_win: { rounds: 1 } },
    periods: { best_of: 3 },
    draw_allowed: false
  }, [event('r', 'score', { team_id: 't1', event_type: 'map_win' }, 1)]);
  assert.equal(round.home.score, 1);
});

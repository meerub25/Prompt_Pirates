const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
const SPORT_IDENTIFIER = /^[a-z0-9_-]{2,40}$/;
const EVENT_TYPES = new Set([
  'match_init',
  'match_start',
  'score',
  'discipline',
  'tiebreak_winner',
  'match_end',
  'compensation'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validateEvent(input) {
  const fields = [];
  const add = name => fields.push(name);
  if (!isObject(input)) return { fields: ['body'] };

  if (!validId(input.event_id)) add('event_id');
  if (!validId(input.match_id)) add('match_id');
  if (!EVENT_TYPES.has(input.type)) add('type');
  if (!isObject(input.payload)) add('payload');

  if (isObject(input.payload)) {
    const payload = input.payload;
    switch (input.type) {
      case 'match_init':
        if (typeof payload.sport_id !== 'string' || !SPORT_IDENTIFIER.test(payload.sport_id)) {
          add('payload.sport_id');
        }
        if (!validId(payload.home_team_id)) add('payload.home_team_id');
        if (!validId(payload.away_team_id)) add('payload.away_team_id');
        if (payload.home_team_id === payload.away_team_id) add('payload.away_team_id');
        if (payload.league_id !== undefined && !validId(payload.league_id)) {
          add('payload.league_id');
        }
        break;
      case 'match_start':
      case 'match_end':
        if (Object.keys(payload).length !== 0) add('payload');
        break;
      case 'score':
        if (!validId(payload.team_id)) add('payload.team_id');
        if (typeof payload.event_type !== 'string') {
          add('payload.event_type');
        }
        break;
      case 'discipline':
        if (!validId(payload.team_id)) add('payload.team_id');
        if (!Number.isSafeInteger(payload.points)) add('payload.points');
        break;
      case 'tiebreak_winner':
        if (!validId(payload.team_id)) add('payload.team_id');
        break;
      case 'compensation':
        if (!validId(payload.compensates)) add('payload.compensates');
        if (typeof payload.reason !== 'string' || payload.reason.length < 1) {
          add('payload.reason');
        }
        break;
      default:
        break;
    }
  }

  return { fields };
}

function compensatedEvents(events) {
  const byId = new Map();
  for (const event of events) {
    if (event.type === 'compensation' && event.payload && event.payload.compensates) {
      byId.set(event.payload.compensates, event.event_id);
    }
  }
  return byId;
}

function compensationError(target, matchId, alreadyCompensated) {
  if (!target) return 'EVENT_NOT_FOUND';
  if (
    target.match_id !== matchId ||
    !['score', 'discipline', 'tiebreak_winner'].includes(target.type) ||
    alreadyCompensated
  ) {
    return 'INVALID_COMPENSATION';
  }
  return null;
}

function activeEvents(events) {
  const compensated = compensatedEvents(events);
  return events.filter(event =>
    event.type !== 'compensation' && !compensated.has(event.event_id)
  );
}

function validateScoreLimit(config, teamId, events) {
  const active = activeEvents(events);
  const model = config.scoring_model;
  if (model === 'innings') {
    let balls = 0;
    let wickets = 0;
    for (const event of active) {
      if (event.type !== 'score' || event.payload.team_id !== teamId) continue;
      const rules = config.scoring_events[event.payload.event_type];
      if (rules.legal_ball) balls += 1;
      if (rules.wicket) wickets += 1;
    }
    if (
      balls >=
        config.periods.innings_per_team *
          config.periods.overs_per_innings *
          config.periods.balls_per_over ||
      wickets >= config.periods.innings_per_team * config.periods.wickets_per_innings
    ) {
      return 'INNINGS_COMPLETE';
    }
  } else if (model === 'round') {
    let rounds = 0;
    for (const event of active) {
      if (event.type !== 'score' || event.payload.team_id !== teamId) continue;
      rounds += config.scoring_events[event.payload.event_type].rounds;
    }
    if (rounds >= (config.periods.best_of + 1) / 2) {
      return 'SERIES_ALREADY_DECIDED';
    }
  }
  return null;
}

function projectScore(match, config, events) {
  const compensated = compensatedEvents(events);
  const projection = {
    match_id: match.match_id,
    sport_id: match.sport_id,
    league_id: match.league_id,
    status: 'upcoming',
    outcome: 'pending',
    winner_team_id: null,
    tiebreak_winner_team_id: null,
    home: {
      team_id: match.home,
      score: 0,
      wickets: config.scoring_model === 'innings' ? 0 : null,
      balls: config.scoring_model === 'innings' ? 0 : null,
      overs: config.scoring_model === 'innings' ? '0.0' : null,
      fair_play: 0
    },
    away: {
      team_id: match.away,
      score: 0,
      wickets: config.scoring_model === 'innings' ? 0 : null,
      balls: config.scoring_model === 'innings' ? 0 : null,
      overs: config.scoring_model === 'innings' ? '0.0' : null,
      fair_play: 0
    },
    version: events.length,
    events: events.map(event => ({
      sequence: event.seq,
      event_id: event.event_id,
      type: event.type,
      payload: event.payload,
      signature: event.signature,
      compensated: compensated.has(event.event_id),
      compensated_by: compensated.get(event.event_id) || null
    }))
  };

  let tiebreakWinner = null;
  for (const event of events) {
    if (event.type === 'match_start') projection.status = 'in_progress';
    if (event.type === 'match_end') projection.status = 'completed';
    if (event.type === 'tiebreak_winner' && !compensated.has(event.event_id)) {
      tiebreakWinner = event.payload.team_id;
    }
    if (compensated.has(event.event_id) || event.type === 'compensation') continue;

    const team = event.payload && event.payload.team_id === match.home
      ? projection.home
      : event.payload && event.payload.team_id === match.away
        ? projection.away
        : null;
    if (event.type === 'discipline' && team) {
      team.fair_play += event.payload.points;
    } else if (event.type === 'score' && team) {
      const rules = config.scoring_events[event.payload.event_type];
      if (config.scoring_model === 'event') {
        team.score += rules.points;
      } else if (config.scoring_model === 'innings') {
        team.score += rules.runs;
        if (rules.legal_ball) team.balls += 1;
        if (rules.wicket) team.wickets += 1;
      } else if (config.scoring_model === 'round') {
        team.score += rules.rounds;
      }
    }
  }

  if (config.scoring_model === 'innings') {
    const ballsPerOver = config.periods.balls_per_over;
    for (const team of [projection.home, projection.away]) {
      team.overs = `${Math.floor(team.balls / ballsPerOver)}.${team.balls % ballsPerOver}`;
    }
  }

  projection.tiebreak_winner_team_id = tiebreakWinner;
  if (projection.status === 'completed') {
    if (projection.home.score > projection.away.score) {
      projection.outcome = 'home_win';
      projection.winner_team_id = match.home;
    } else if (projection.away.score > projection.home.score) {
      projection.outcome = 'away_win';
      projection.winner_team_id = match.away;
    } else if (tiebreakWinner) {
      projection.outcome = tiebreakWinner === match.home ? 'home_win' : 'away_win';
      projection.winner_team_id = tiebreakWinner;
    } else if (config.draw_allowed) {
      projection.outcome = 'draw';
    } else {
      projection.outcome = 'undecided';
    }
  }

  return projection;
}

module.exports = {
  activeEvents,
  compensationError,
  projectScore,
  validateEvent,
  validateScoreLimit
};

const DEFAULT_TIE_BREAK_ORDER = [
  'h2h_points',
  'h2h_diff',
  'overall_diff',
  'scored',
  'fair_play',
  'draw_lots'
];

const TIE_BREAKS = new Set(DEFAULT_TIE_BREAK_ORDER);
const OVERTIME_POLICIES = new Set([
  'none',
  'extra_time',
  'shootout',
  'golden_score',
  'super_over'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validateSport(input) {
  const fields = [];
  const field = name => fields.push(name);

  if (!isObject(input)) {
    return { fields: ['body'] };
  }

  if (typeof input.sport_id !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(input.sport_id)) {
    field('sport_id');
  }
  if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 80) {
    field('name');
  }
  if (!['event', 'innings', 'round'].includes(input.scoring_model)) {
    field('scoring_model');
  }

  const periods = input.periods;
  if (!isObject(periods)) {
    field('periods');
  } else if (input.scoring_model === 'event') {
    if (!validInteger(periods.count, 1)) field('periods.count');
    if (!validInteger(periods.duration_minutes, 1)) field('periods.duration_minutes');
  } else if (input.scoring_model === 'innings') {
    for (const key of [
      'innings_per_team',
      'overs_per_innings',
      'balls_per_over',
      'wickets_per_innings'
    ]) {
      if (!validInteger(periods[key], 1)) field(`periods.${key}`);
    }
  } else if (input.scoring_model === 'round') {
    if (!validInteger(periods.best_of, 1) || periods.best_of % 2 !== 1) {
      field('periods.best_of');
    }
  }

  if (!isObject(input.scoring_events) || Object.keys(input.scoring_events).length < 1) {
    field('scoring_events');
  } else {
    for (const [eventType, rules] of Object.entries(input.scoring_events)) {
      if (!/^[a-z0-9_]{1,40}$/.test(eventType)) {
        field(`scoring_events.${eventType}`);
      }
      if (!isObject(rules)) {
        field(`scoring_events.${eventType}`);
        continue;
      }
      if (input.scoring_model === 'event') {
        if (!validInteger(rules.points, 1)) field(`scoring_events.${eventType}.points`);
      } else if (input.scoring_model === 'innings') {
        if (!validInteger(rules.runs, 0)) field(`scoring_events.${eventType}.runs`);
        if (typeof rules.legal_ball !== 'boolean') {
          field(`scoring_events.${eventType}.legal_ball`);
        }
        if (typeof rules.wicket !== 'boolean') {
          field(`scoring_events.${eventType}.wicket`);
        }
      } else if (input.scoring_model === 'round') {
        if (!validInteger(rules.rounds, 1)) field(`scoring_events.${eventType}.rounds`);
      }
    }
  }

  if (typeof input.draw_allowed !== 'boolean') field('draw_allowed');

  if (!isObject(input.overtime)) {
    field('overtime');
  } else {
    if (!OVERTIME_POLICIES.has(input.overtime.policy)) field('overtime.policy');
    if (
      input.overtime.duration_minutes !== undefined &&
      !validInteger(input.overtime.duration_minutes, 0)
    ) {
      field('overtime.duration_minutes');
    }
  }

  let tieBreakOrder = DEFAULT_TIE_BREAK_ORDER;
  if (input.tie_break_order !== undefined) {
    if (!Array.isArray(input.tie_break_order)) {
      field('tie_break_order');
    } else {
      const valid = input.tie_break_order.every(item => TIE_BREAKS.has(item));
      const unique = new Set(input.tie_break_order).size === input.tie_break_order.length;
      if (!valid || !unique) field('tie_break_order');
      else {
        tieBreakOrder = input.tie_break_order.filter(item => item !== 'draw_lots');
        tieBreakOrder.push('draw_lots');
      }
    }
  }

  if (!isObject(input.roster)) {
    field('roster');
  } else {
    const min = input.roster.min_squad_size;
    const max = input.roster.max_squad_size;
    if (!validInteger(min, 1)) field('roster.min_squad_size');
    if (!validInteger(max, 1)) field('roster.max_squad_size');
    if (validInteger(min, 1) && validInteger(max, 1) && min > max) {
      field('roster.max_squad_size');
    }
    if (!isObject(input.roster.required_positions)) {
      field('roster.required_positions');
    } else {
      for (const [position, count] of Object.entries(input.roster.required_positions)) {
        if (!position || !validInteger(count, 0)) {
          field(`roster.required_positions.${position}`);
        }
      }
    }
  }

  if (fields.length > 0) return { fields };

  let normalizedPeriods;
  if (input.scoring_model === 'event') {
    normalizedPeriods = {
      count: periods.count,
      duration_minutes: periods.duration_minutes
    };
  } else if (input.scoring_model === 'innings') {
    normalizedPeriods = {
      innings_per_team: periods.innings_per_team,
      overs_per_innings: periods.overs_per_innings,
      balls_per_over: periods.balls_per_over,
      wickets_per_innings: periods.wickets_per_innings
    };
  } else {
    normalizedPeriods = { best_of: periods.best_of };
  }

  const normalizedEvents = Object.create(null);
  for (const [eventType, rules] of Object.entries(input.scoring_events)) {
    if (input.scoring_model === 'event') {
      normalizedEvents[eventType] = { points: rules.points };
    } else if (input.scoring_model === 'innings') {
      normalizedEvents[eventType] = {
        runs: rules.runs,
        legal_ball: rules.legal_ball,
        wicket: rules.wicket
      };
    } else {
      normalizedEvents[eventType] = { rounds: rules.rounds };
    }
  }

  const normalizedOvertime = { policy: input.overtime.policy };
  if (input.overtime.duration_minutes !== undefined) {
    normalizedOvertime.duration_minutes = input.overtime.duration_minutes;
  }

  return {
    fields: [],
    config: {
      sport_id: input.sport_id,
      name: input.name,
      scoring_model: input.scoring_model,
      periods: normalizedPeriods,
      scoring_events: normalizedEvents,
      draw_allowed: input.draw_allowed,
      overtime: normalizedOvertime,
      tie_break_order: tieBreakOrder,
      roster: {
        min_squad_size: input.roster.min_squad_size,
        max_squad_size: input.roster.max_squad_size,
        required_positions: { ...input.roster.required_positions }
      }
    }
  };
}

module.exports = { DEFAULT_TIE_BREAK_ORDER, validateSport };

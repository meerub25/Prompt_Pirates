const { DEFAULT_TIE_BREAK_ORDER } = require('./sports');

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
const TIE_BREAKS = new Set(DEFAULT_TIE_BREAK_ORDER);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validateLeague(input) {
  const fields = [];
  const add = name => fields.push(name);
  if (!isObject(input)) return { fields: ['body'], duplicateMatchIds: [] };

  if (!validId(input.league_id)) add('league_id');
  if (!validId(input.sport_id)) add('sport_id');

  const teams = input.teams;
  if (!Array.isArray(teams) || teams.length < 2 || teams.length > 40) {
    add('teams');
  } else {
    if (teams.some(team => !validId(team))) add('teams');
    if (new Set(teams).size !== teams.length) add('teams');
  }

  const duplicateMatchIds = [];
  if (!Array.isArray(input.fixtures)) {
    add('fixtures');
  } else {
    const matchIds = new Set();
    input.fixtures.forEach((fixture, index) => {
      const prefix = `fixtures.${index}`;
      if (!isObject(fixture)) {
        add(prefix);
        return;
      }
      if (!validId(fixture.match_id)) add(`${prefix}.match_id`);
      else if (matchIds.has(fixture.match_id)) duplicateMatchIds.push(fixture.match_id);
      else matchIds.add(fixture.match_id);
      if (!validId(fixture.home)) add(`${prefix}.home`);
      if (!validId(fixture.away)) add(`${prefix}.away`);
      if (fixture.home === fixture.away) add(`${prefix}.away`);
      if (Array.isArray(teams)) {
        if (!teams.includes(fixture.home)) add(`${prefix}.home`);
        if (!teams.includes(fixture.away)) add(`${prefix}.away`);
      }
    });
  }

  let points = { win: 3, draw: 1, loss: 0 };
  if (input.points !== undefined) {
    if (!isObject(input.points)) {
      add('points');
    } else {
      for (const key of ['win', 'draw', 'loss']) {
        if (input.points[key] !== undefined) points[key] = input.points[key];
        if (input.points[key] !== undefined && !Number.isSafeInteger(input.points[key])) {
          add(`points.${key}`);
        }
      }
    }
  }

  let tieBreakOrder = null;
  if (input.tie_break_order !== undefined) {
    if (!Array.isArray(input.tie_break_order)) {
      add('tie_break_order');
    } else {
      const valid = input.tie_break_order.every(value => TIE_BREAKS.has(value));
      const unique = new Set(input.tie_break_order).size === input.tie_break_order.length;
      if (!valid || !unique) add('tie_break_order');
      else {
        tieBreakOrder = input.tie_break_order.filter(value => value !== 'draw_lots');
        tieBreakOrder.push('draw_lots');
      }
    }
  }

  const qualification = input.qualification;
  if (!isObject(qualification)) {
    add('qualification');
  } else if (
    !Number.isSafeInteger(qualification.spots) ||
    qualification.spots < 1 ||
    !Array.isArray(teams) ||
    qualification.spots > teams.length
  ) {
    add('qualification.spots');
  }

  if (input.lots_seed !== undefined && !Number.isSafeInteger(input.lots_seed)) {
    add('lots_seed');
  }

  return {
    fields: [...new Set(fields)],
    duplicateMatchIds,
    config: fields.length === 0
      ? {
          league_id: input.league_id,
          sport_id: input.sport_id,
          teams: [...teams],
          fixtures: input.fixtures.map(fixture => ({
            match_id: fixture.match_id,
            home: fixture.home,
            away: fixture.away
          })),
          points,
          tie_break_order: tieBreakOrder,
          qualification: { spots: qualification.spots },
          lots_seed: input.lots_seed
        }
      : undefined
  };
}

module.exports = { validateLeague };

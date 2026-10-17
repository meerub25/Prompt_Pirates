const { pool } = require('../db');
const { projectScore } = require('./scoring');

async function loadScore(matchId, queryable = pool) {
  const matchResult = await queryable.query(
    'SELECT match_id, sport_id, league_id, home, away FROM matches WHERE match_id = $1',
    [matchId]
  );
  if (matchResult.rowCount === 0) return null;
  const match = matchResult.rows[0];
  const [sportResult, eventResult] = await Promise.all([
    queryable.query('SELECT config FROM sports WHERE sport_id = $1', [match.sport_id]),
    queryable.query(
      `SELECT event_id, match_id, type, payload, signature, seq
       FROM events WHERE match_id = $1 ORDER BY seq`,
      [match.match_id]
    )
  ]);
  if (sportResult.rowCount === 0) return null;
  return projectScore(match, sportResult.rows[0].config, eventResult.rows);
}

module.exports = { loadScore };

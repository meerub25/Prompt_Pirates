const { pool } = require('../db');
const { loadStandings } = require('../logic/standings');
const { fail } = require('../util');

async function handleStandings(req, res, next) {
  try {
    const standings = await loadStandings(req.params.league_id, pool);
    if (!standings) {
      return fail(res, 404, 'LEAGUE_NOT_FOUND', 'The requested league does not exist.');
    }
    return res.json(standings);
  } catch (error) {
    return next(error);
  }
}

module.exports = { handleStandings };

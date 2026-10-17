const express = require('express');
const { pool } = require('../db');
const { ApiError, sendApiError } = require('../logic/api-error');
const { validateLeague } = require('../logic/leagues');
const { fail } = require('../util');

const router = express.Router();

router.post('/leagues', async (req, res, next) => {
  const validation = validateLeague(req.body);
  if (validation.fields.length > 0) {
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'League configuration is invalid.',
      { fields: validation.fields }
    );
  }

  const league = validation.config;
  let client;
  let transactionOpen = false;
  try {
    const sportResult = await pool.query(
      'SELECT config FROM sports WHERE sport_id = $1',
      [league.sport_id]
    );
    if (sportResult.rowCount === 0) {
      throw new ApiError(404, 'SPORT_NOT_FOUND', 'The requested sport does not exist.');
    }

    const settingResult = await pool.query(
      "SELECT value FROM settings WHERE key = 'lots_seed'"
    );
    const resetSeed = settingResult.rowCount === 0 ? 42 : Number(settingResult.rows[0].value);
    league.lots_seed = league.lots_seed === undefined ? resetSeed : league.lots_seed;
    league.tie_break_order = league.tie_break_order ||
      sportResult.rows[0].config.tie_break_order;

    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    const lockKeys = [
      `league:${league.league_id}`,
      ...league.fixtures.map(fixture => `match:${fixture.match_id}`)
    ].sort();
    for (const key of lockKeys) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }

    const existingLeague = await client.query(
      'SELECT 1 FROM leagues WHERE league_id = $1',
      [league.league_id]
    );
    if (existingLeague.rowCount > 0) {
      throw new ApiError(409, 'LEAGUE_EXISTS', 'League id is already in use.');
    }

    if (validation.duplicateMatchIds.length > 0) {
      throw new ApiError(409, 'MATCH_EXISTS', 'A fixture match id is duplicated.');
    }
    if (league.fixtures.length > 0) {
      const matchIds = league.fixtures.map(fixture => fixture.match_id);
      const existingMatches = await client.query(
        'SELECT match_id FROM matches WHERE match_id = ANY($1::text[])',
        [matchIds]
      );
      if (existingMatches.rowCount > 0) {
        throw new ApiError(409, 'MATCH_EXISTS', 'A fixture match id is already in use.');
      }
    }

    await client.query(
      'INSERT INTO leagues (league_id, config) VALUES ($1, $2::jsonb)',
      [league.league_id, JSON.stringify(league)]
    );
    for (const fixture of league.fixtures) {
      await client.query(
        `INSERT INTO matches (match_id, sport_id, league_id, home, away)
         VALUES ($1, $2, $3, $4, $5)`,
        [fixture.match_id, league.sport_id, league.league_id, fixture.home, fixture.away]
      );
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return res.status(201).json({
      league_id: league.league_id,
      status: 'created',
      team_count: league.teams.length,
      fixture_count: league.fixtures.length
    });
  } catch (error) {
    if (client && transactionOpen) {
      await client.query('ROLLBACK');
      transactionOpen = false;
    }
    if (error instanceof ApiError) return sendApiError(res, error);
    if (error.code === '23505') {
      return sendApiError(
        res,
        new ApiError(409, 'MATCH_EXISTS', 'A league or fixture id is already in use.')
      );
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;

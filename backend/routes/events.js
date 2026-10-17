const express = require('express');
const { pool } = require('../db');
const { canonical, sign } = require('../sign');
const { ApiError, sendApiError } = require('../logic/api-error');
const {
  compensationError,
  projectScore,
  validateEvent,
  validateScoreLimit
} = require('../logic/scoring');
const { fail } = require('../util');

const router = express.Router();

function eventResponse(event) {
  return {
    event_id: event.event_id,
    match_id: event.match_id,
    type: event.type,
    sequence: event.seq,
    match_version: event.seq,
    signature: event.signature
  };
}

function scoreStateError(type, status) {
  if (type === 'match_start') {
    return status === 'upcoming'
      ? null
      : new ApiError(409, 'ILLEGAL_TRANSITION', 'Only an upcoming match can be started.');
  }
  if (type === 'match_end') {
    return status === 'in_progress'
      ? null
      : new ApiError(409, 'ILLEGAL_TRANSITION', 'Only an in-progress match can be ended.');
  }
  if (['score', 'discipline', 'tiebreak_winner'].includes(type)) {
    return status === 'in_progress'
      ? null
      : new ApiError(409, 'MATCH_NOT_IN_PROGRESS', 'The match is not in progress.');
  }
  return null;
}

router.post('/events', async (req, res, next) => {
  const validation = validateEvent(req.body);
  if (validation.fields.length > 0) {
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Event is invalid.',
      { fields: [...new Set(validation.fields)] }
    );
  }

  const body = req.body;
  const payload = body.payload;
  let client;
  let transactionOpen = false;
  let duplicateRequest = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`event:${body.event_id}`]
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`match:${body.match_id}`]
    );

    const existingEvent = await client.query(
      'SELECT event_id, match_id, type, payload, body, signature, seq FROM events WHERE event_id = $1',
      [body.event_id]
    );
    if (existingEvent.rowCount > 0) {
      const stored = existingEvent.rows[0];
      if (canonical(stored.body) !== canonical(body)) {
        duplicateRequest = true;
      } else {
        await client.query('COMMIT');
        transactionOpen = false;
        return res.status(200).json(eventResponse(stored));
      }
    }

    let match;
    let config;
    if (body.type === 'match_init') {
      const sportResult = await client.query(
        'SELECT config FROM sports WHERE sport_id = $1',
        [payload.sport_id]
      );
      if (sportResult.rowCount === 0) {
        throw new ApiError(404, 'SPORT_NOT_FOUND', 'The requested sport does not exist.');
      }
      config = sportResult.rows[0].config;
      if (payload.league_id !== undefined) {
        const leagueResult = await client.query(
          'SELECT 1 FROM leagues WHERE league_id = $1',
          [payload.league_id]
        );
        if (leagueResult.rowCount === 0) {
          throw new ApiError(404, 'LEAGUE_NOT_FOUND', 'The requested league does not exist.');
        }
      }

      if (duplicateRequest) {
        throw new ApiError(
          409,
          'DUPLICATE_EVENT_ID',
          'Event id was already used with a different request.'
        );
      }

      const existingMatch = await client.query(
        'SELECT 1 FROM matches WHERE match_id = $1',
        [body.match_id]
      );
      if (existingMatch.rowCount > 0) {
        throw new ApiError(409, 'MATCH_EXISTS', 'Match id is already in use.');
      }

      await client.query(
        `INSERT INTO matches (match_id, sport_id, league_id, home, away)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          body.match_id,
          payload.sport_id,
          payload.league_id || null,
          payload.home_team_id,
          payload.away_team_id
        ]
      );
      match = {
        match_id: body.match_id,
        sport_id: payload.sport_id,
        league_id: payload.league_id || null,
        home: payload.home_team_id,
        away: payload.away_team_id
      };
    } else {
      const matchResult = await client.query(
        'SELECT match_id, sport_id, league_id, home, away FROM matches WHERE match_id = $1 FOR UPDATE',
        [body.match_id]
      );
      if (matchResult.rowCount === 0) {
        throw new ApiError(404, 'MATCH_NOT_FOUND', 'The requested match does not exist.');
      }
      match = matchResult.rows[0];
      const sportResult = await client.query(
        'SELECT config FROM sports WHERE sport_id = $1',
        [match.sport_id]
      );
      if (sportResult.rowCount === 0) {
        throw new ApiError(404, 'SPORT_NOT_FOUND', 'The match sport does not exist.');
      }
      config = sportResult.rows[0].config;
    }

    const logResult = await client.query(
      `SELECT event_id, match_id, type, payload, signature, seq
       FROM events WHERE match_id = $1 ORDER BY seq`,
      [body.match_id]
    );
    const events = logResult.rows;
    const projection = projectScore(match, config, events);
    let compensationCode = null;

    if (body.type === 'score') {
      if (!Object.hasOwn(config.scoring_events, payload.event_type)) {
        throw new ApiError(
          400,
          'UNKNOWN_EVENT_TYPE',
          'The scoring event type is not defined for this sport.',
          { event_type: payload.event_type }
        );
      }
      if (![match.home, match.away].includes(payload.team_id)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'team_id must be a match participant.', {
          fields: ['payload.team_id']
        });
      }
    } else if (
      ['discipline', 'tiebreak_winner'].includes(body.type) &&
      ![match.home, match.away].includes(payload.team_id)
    ) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'team_id must be a match participant.', {
        fields: ['payload.team_id']
      });
    }

    if (body.type === 'compensation') {
      const targetResult = await client.query(
        'SELECT event_id, match_id, type FROM events WHERE event_id = $1',
        [payload.compensates]
      );
      const target = targetResult.rows[0] || null;
      const alreadyCompensated = events.some(
        event => event.type === 'compensation' &&
          event.payload.compensates === payload.compensates
      );
      compensationCode = compensationError(target, body.match_id, alreadyCompensated);
      if (compensationCode === 'EVENT_NOT_FOUND') {
        throw new ApiError(404, compensationCode, 'The event to compensate does not exist.');
      }
    }

    if (duplicateRequest) {
      throw new ApiError(
        409,
        'DUPLICATE_EVENT_ID',
        'Event id was already used with a different request.'
      );
    }

    const stateError = scoreStateError(body.type, projection.status);
    if (stateError) throw stateError;

    if (body.type === 'score') {
      const limitError = validateScoreLimit(config, payload.team_id, events);
      if (limitError === 'INNINGS_COMPLETE') {
        throw new ApiError(409, limitError, 'The team has completed its innings.');
      }
      if (limitError === 'SERIES_ALREADY_DECIDED') {
        throw new ApiError(409, limitError, 'The series has already been decided.');
      }
    } else if (body.type === 'compensation') {
      if (compensationCode) {
        throw new ApiError(
          409,
          compensationCode,
          'The requested event cannot be compensated.'
        );
      }
    } else if (body.type === 'match_end') {
      if (
        projection.home.score === projection.away.score &&
        !config.draw_allowed &&
        !projection.tiebreak_winner_team_id
      ) {
        throw new ApiError(
          409,
          'TIE_NOT_ALLOWED',
          'A tiebreak winner is required to end this tied match.'
        );
      }
    }

    const seqResult = await client.query(
      'SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq FROM events WHERE match_id = $1',
      [body.match_id]
    );
    const seq = seqResult.rows[0].seq;
    const signature = sign(body.event_id, payload);
    const inserted = await client.query(
      `INSERT INTO events (match_id, event_id, type, payload, body, signature, seq)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING event_id, match_id, type, payload, signature, seq`,
      [
        body.match_id,
        body.event_id,
        body.type,
        JSON.stringify(payload),
        JSON.stringify(body),
        signature,
        seq
      ]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return res.status(201).json(eventResponse(inserted.rows[0]));
  } catch (error) {
    if (client && transactionOpen) {
      await client.query('ROLLBACK');
      transactionOpen = false;
    }
    if (error instanceof ApiError) return sendApiError(res, error);
    return next(error);
  } finally {
    if (client) client.release();
  }
});

router.get('/score/:match_id', async (req, res, next) => {
  try {
    const matchResult = await pool.query(
      'SELECT match_id, sport_id, league_id, home, away FROM matches WHERE match_id = $1',
      [req.params.match_id]
    );
    if (matchResult.rowCount === 0) {
      return fail(res, 404, 'MATCH_NOT_FOUND', 'The requested match does not exist.');
    }
    const match = matchResult.rows[0];
    const [sportResult, eventResult] = await Promise.all([
      pool.query('SELECT config FROM sports WHERE sport_id = $1', [match.sport_id]),
      pool.query(
        `SELECT event_id, match_id, type, payload, signature, seq
         FROM events WHERE match_id = $1 ORDER BY seq`,
        [match.match_id]
      )
    ]);
    if (sportResult.rowCount === 0) {
      return fail(res, 404, 'SPORT_NOT_FOUND', 'The match sport does not exist.');
    }
    return res.json(projectScore(match, sportResult.rows[0].config, eventResult.rows));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

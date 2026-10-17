const { canonical, sign } = require('../sign');
const { pool } = require('../db');
const { fail } = require('../util');
const { projectScore, validateEvent, validateScoreLimit } = require('../logic/scoring');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function validateEnvelope(body) {
  const fields = [];
  if (!isObject(body)) return ['body'];
  if (!validId(body.device_id)) fields.push('device_id');
  if (!Array.isArray(body.actions) || body.actions.length < 1 || body.actions.length > 100) {
    fields.push('actions');
    return fields;
  }
  const actionIds = new Set();
  body.actions.forEach((action, index) => {
    if (!isObject(action)) {
      fields.push(`actions.${index}`);
      return;
    }
    if (!validId(action.action_id)) fields.push(`actions.${index}.action_id`);
    if (actionIds.has(action.action_id)) fields.push(`actions.${index}.action_id`);
    actionIds.add(action.action_id);
    if (!['score_event', 'roster_transfer'].includes(action.type)) {
      fields.push(`actions.${index}.type`);
    }
    if (typeof action.queued_at !== 'string' || Number.isNaN(Date.parse(action.queued_at))) {
      fields.push(`actions.${index}.queued_at`);
    }
    if (!Number.isSafeInteger(action.base_version) || action.base_version < 0) {
      fields.push(`actions.${index}.base_version`);
    }
    if (!isObject(action.payload)) fields.push(`actions.${index}.payload`);
    if (action.type === 'score_event' && isObject(action.payload)) {
      fields.push(...validateEvent(action.payload).fields.map(field => `actions.${index}.payload.${field}`));
    }
    if (action.type === 'roster_transfer' && isObject(action.payload)) {
      for (const field of ['request_id', 'league_id', 'player_id', 'type', 'from_squad_id', 'effective_date']) {
        if (action.payload[field] === undefined) fields.push(`actions.${index}.payload.${field}`);
      }
    }
  });
  return [...new Set(fields)];
}

function actionResult(action, status, resolution, errorCode, processedOrder, serverVersion, signature = null) {
  return {
    action_id: action.action_id,
    status,
    resolution,
    error_code: errorCode,
    processed_order: processedOrder,
    server_version: serverVersion,
    signature
  };
}

async function currentPlayerVersion(client, playerId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS version
     FROM clubs, jsonb_array_elements(roster) AS player
     WHERE player->>'player_id' = $1`,
    [playerId]
  );
  return result.rows[0].version;
}

async function processScoreAction(client, action) {
  const request = action.payload;
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`offline-event:${request.event_id}`]
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`match:${request.match_id}`]
    );
    const existingEvent = await client.query(
      'SELECT event_id, body, signature FROM events WHERE event_id = $1',
      [request.event_id]
    );
    if (existingEvent.rowCount > 0) {
      const existing = existingEvent.rows[0];
      const duplicate = canonical(existing.body) === canonical(request);
      await client.query('COMMIT');
      transactionOpen = false;
      if (duplicate) {
        const count = await client.query(
          'SELECT COUNT(*)::int AS version FROM events WHERE match_id = $1',
          [request.match_id]
        );
        return {
          duplicate: true,
          serverVersion: count.rows[0].version,
          signature: existing.signature
        };
      }
      return { errorCode: 'DUPLICATE_EVENT_ID', serverVersion: 0 };
    }

    const matchResult = await client.query(
      'SELECT match_id, sport_id, league_id, home, away FROM matches WHERE match_id = $1 FOR UPDATE',
      [request.match_id]
    );
    if (matchResult.rowCount === 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { errorCode: 'MATCH_NOT_FOUND', serverVersion: 0 };
    }
    const match = matchResult.rows[0];
    const sportResult = await client.query(
      'SELECT config FROM sports WHERE sport_id = $1',
      [match.sport_id]
    );
    const config = sportResult.rows[0].config;
    const logResult = await client.query(
      `SELECT event_id, match_id, type, payload, signature, seq
       FROM events WHERE match_id = $1 ORDER BY seq`,
      [request.match_id]
    );
    const events = logResult.rows;
    const version = events.length;
    if (action.base_version > version) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { errorCode: 'INVALID_BASE_VERSION', serverVersion: version };
    }
    if (request.type === 'match_init') {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { errorCode: 'MATCH_EXISTS', serverVersion: version };
    }
    const score = projectScore(match, config, events);
    if (request.type === 'match_start' && score.status !== 'upcoming') {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { errorCode: 'ILLEGAL_TRANSITION', serverVersion: version };
    }
    if (request.type === 'match_end' && score.status !== 'in_progress') {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { errorCode: 'ILLEGAL_TRANSITION', serverVersion: version };
    }
    if (['score', 'discipline', 'tiebreak_winner'].includes(request.type)) {
      if (score.status !== 'in_progress') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { errorCode: 'MATCH_NOT_IN_PROGRESS', serverVersion: version };
      }
    }
    if (request.type === 'score') {
      if (!Object.hasOwn(config.scoring_events, request.payload.event_type)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { errorCode: 'UNKNOWN_EVENT_TYPE', serverVersion: version };
      }
      if (![match.home, match.away].includes(request.payload.team_id)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { errorCode: 'VALIDATION_ERROR', serverVersion: version };
      }
      const limit = validateScoreLimit(config, request.payload.team_id, events);
      if (limit) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { errorCode: limit, serverVersion: version };
      }
    }
    if (request.type === 'compensation') {
      const targetResult = await client.query(
        'SELECT match_id, type FROM events WHERE event_id = $1',
        [request.payload.compensates]
      );
      if (targetResult.rowCount === 0) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { errorCode: 'EVENT_NOT_FOUND', serverVersion: version };
      }
      const target = targetResult.rows[0];
      if (
        target.match_id !== request.match_id ||
        !['score', 'discipline', 'tiebreak_winner'].includes(target.type) ||
        events.some(event =>
          event.type === 'compensation' &&
          event.payload.compensates === request.payload.compensates
        )
      ) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { errorCode: 'INVALID_COMPENSATION', serverVersion: version };
      }
    }

    const seq = version + 1;
    const signature = sign(request.event_id, request.payload);
    await client.query(
      `INSERT INTO events (match_id, event_id, type, payload, body, signature, seq)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
      [
        request.match_id,
        request.event_id,
        request.type,
        JSON.stringify(request.payload),
        JSON.stringify(request),
        signature,
        seq
      ]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { applied: true, serverVersion: seq, signature };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  }
}

async function handleOfflineSync(req, res, next) {
  const fields = validateEnvelope(req.body);
  if (fields.length > 0) {
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Offline sync request is invalid.',
      { fields }
    );
  }

  const { device_id: deviceId, actions } = req.body;
  const indexed = actions.map((action, index) => ({ action, index }));
  indexed.sort((left, right) => {
    const dateDifference = Date.parse(left.action.queued_at) - Date.parse(right.action.queued_at);
    return dateDifference || left.index - right.index;
  });
  const resultByIndex = new Array(actions.length);
  let client;
  try {
    client = await pool.connect();
    for (const [sortedIndex, item] of indexed.entries()) {
      const { action, index } = item;
      const request = { action_id: action.action_id, type: action.type, ...action };
      const previous = await client.query(
        'SELECT request FROM offline_actions WHERE device_id = $1 AND action_id = $2',
        [deviceId, action.action_id]
      );
      if (previous.rowCount > 0) {
        const version = action.type === 'score_event'
          ? await client.query(
              'SELECT COUNT(*)::int AS version FROM events WHERE match_id = $1',
              [action.payload.match_id]
            )
          : { rows: [{ version: await currentPlayerVersion(client, action.payload.player_id) }] };
        resultByIndex[index] = actionResult(
          action,
          'duplicate',
          'skipped_duplicate',
          null,
          sortedIndex + 1,
          version.rows[0].version
        );
        continue;
      }

      let outcome;
      if (action.type === 'score_event') {
        outcome = await processScoreAction(client, action);
      } else {
        const player = await client.query(
          `SELECT 1 FROM clubs, jsonb_array_elements(roster) AS player
           WHERE player->>'player_id' = $1`,
          [action.payload.player_id]
        );
        outcome = {
          errorCode: player.rowCount === 0 ? 'PLAYER_NOT_FOUND' : 'NOT_IN_SQUAD',
          serverVersion: await currentPlayerVersion(client, action.payload.player_id)
        };
      }

      const status = outcome.applied ? 'applied' :
        outcome.duplicate ? 'duplicate' : 'rejected';
      const resolution = outcome.applied ? 'rebased_append' :
        outcome.duplicate ? 'skipped_duplicate' : 'server_wins';
      const result = actionResult(
        action,
        status,
        resolution,
        outcome.errorCode || null,
        sortedIndex + 1,
        outcome.serverVersion,
        outcome.applied ? outcome.signature : null
      );
      await client.query(
        `INSERT INTO offline_actions (device_id, action_id, request, response)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
        [deviceId, action.action_id, JSON.stringify(request), JSON.stringify(result)]
      );
      resultByIndex[index] = result;
    }
    const summary = {
      applied: resultByIndex.filter(result => result.status === 'applied').length,
      rejected: resultByIndex.filter(result => result.status === 'rejected').length,
      duplicate: resultByIndex.filter(result => result.status === 'duplicate').length
    };
    return res.json({ device_id: deviceId, results: resultByIndex, summary });
  } catch (error) {
    return next(error);
  } finally {
    if (client) client.release();
  }
}

module.exports = { handleOfflineSync };

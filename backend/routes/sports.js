const express = require('express');
const { pool } = require('../db');
const { ApiError, sendApiError } = require('../logic/api-error');
const { validateSport } = require('../logic/sports');
const { fail } = require('../util');

const router = express.Router();

router.post('/sports', async (req, res, next) => {
  const validation = validateSport(req.body);
  if (validation.fields.length > 0) {
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Sport configuration is invalid.',
      { fields: validation.fields }
    );
  }

  try {
    const result = await pool.query(
      'INSERT INTO sports (sport_id, config) VALUES ($1, $2::jsonb) ON CONFLICT (sport_id) DO NOTHING RETURNING sport_id',
      [validation.config.sport_id, JSON.stringify(validation.config)]
    );
    if (result.rowCount === 0) {
      throw new ApiError(409, 'SPORT_EXISTS', 'Sport id is already in use.');
    }
    return res.status(201).json({
      sport_id: validation.config.sport_id,
      status: 'created',
      config: validation.config
    });
  } catch (error) {
    if (error instanceof ApiError) return sendApiError(res, error);
    return next(error);
  }
});

module.exports = router;

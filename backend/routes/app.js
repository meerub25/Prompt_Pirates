const express = require('express');
const { pool } = require('../db');
const { verifyPassword } = require('../auth/password');
const { signToken } = require('../auth/jwt');
const { authenticate } = require('../auth/middleware');
const { loadScore } = require('../logic/score-reader');
const { loadStandings } = require('../logic/standings');
const { handleOfflineSync } = require('./offline-sync');
const { fail } = require('../util');

const router = express.Router();

function tenantAllowed(auth, tenantId) {
  return auth.role === 'super_admin' || !tenantId || auth.tenant_id === tenantId;
}

router.post('/auth/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return fail(res, 400, 'VALIDATION_ERROR', 'Email and password are required.', {
      fields: [
        ...(typeof email !== 'string' ? ['email'] : []),
        ...(typeof password !== 'string' ? ['password'] : [])
      ]
    });
  }
  try {
    const result = await pool.query(
      `SELECT email, password_hash, role, tenant_id, own_league_id, own_club_id, own_player_id
       FROM app_users WHERE email = $1`,
      [email]
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(email, password, user.password_hash)) {
      return fail(res, 401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
    }
    const claims = {
      sub: user.email,
      role: user.role,
      tenant_id: user.tenant_id,
      own_league_id: user.own_league_id,
      own_club_id: user.own_club_id,
      own_player_id: user.own_player_id
    };
    const responseUser = { email: user.email };
    for (const field of ['own_league_id', 'own_club_id', 'own_player_id']) {
      if (user[field]) responseUser[field] = user[field];
    }
    return res.json({
      token: signToken(claims),
      role: user.role,
      tenant_id: user.tenant_id,
      user: responseUser
    });
  } catch (error) {
    return next(error);
  }
});

router.use(authenticate);

router.get('/matches', async (req, res, next) => {
  if (typeof req.query.league_id !== 'string') {
    return fail(res, 400, 'VALIDATION_ERROR', 'league_id query parameter is required.', {
      fields: ['league_id']
    });
  }
  try {
    const leagueResult = await pool.query(
      'SELECT config FROM leagues WHERE league_id = $1',
      [req.query.league_id]
    );
    if (leagueResult.rowCount === 0) {
      return fail(res, 404, 'LEAGUE_NOT_FOUND', 'The requested league does not exist.');
    }
    const league = leagueResult.rows[0].config;
    if (!tenantAllowed(req.auth, league.tenant_id)) {
      return fail(res, 403, 'FORBIDDEN', 'This league is outside your tenant.');
    }
    const matchResult = await pool.query(
      'SELECT match_id, home, away FROM matches WHERE league_id = $1 ORDER BY match_id',
      [req.query.league_id]
    );
    const matches = await Promise.all(matchResult.rows.map(async match => {
      const score = await loadScore(match.match_id);
      return {
        match_id: match.match_id,
        home: match.home,
        away: match.away,
        status: score.status,
        score: { home: score.home.score, away: score.away.score }
      };
    }));
    return res.json({ league_id: req.query.league_id, matches });
  } catch (error) {
    return next(error);
  }
});

router.get('/matches/:match_id', async (req, res, next) => {
  try {
    const score = await loadScore(req.params.match_id);
    if (!score) return fail(res, 404, 'MATCH_NOT_FOUND', 'The requested match does not exist.');
    if (score.league_id) {
      const leagueResult = await pool.query(
        'SELECT config FROM leagues WHERE league_id = $1',
        [score.league_id]
      );
      const league = leagueResult.rows[0] && leagueResult.rows[0].config;
      if (league && !tenantAllowed(req.auth, league.tenant_id)) {
        return fail(res, 403, 'FORBIDDEN', 'This match is outside your tenant.');
      }
    }
    return res.json(score);
  } catch (error) {
    return next(error);
  }
});

router.get('/leagues/:league_id/standings', async (req, res, next) => {
  try {
    const leagueResult = await pool.query(
      'SELECT config FROM leagues WHERE league_id = $1',
      [req.params.league_id]
    );
    if (leagueResult.rowCount === 0) {
      return fail(res, 404, 'LEAGUE_NOT_FOUND', 'The requested league does not exist.');
    }
    if (!tenantAllowed(req.auth, leagueResult.rows[0].config.tenant_id)) {
      return fail(res, 403, 'FORBIDDEN', 'This league is outside your tenant.');
    }
    const standings = await loadStandings(req.params.league_id);
    if (!standings) return fail(res, 404, 'LEAGUE_NOT_FOUND', 'The requested league does not exist.');
    return res.json(standings);
  } catch (error) {
    return next(error);
  }
});

router.get('/clubs/:club_id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT club_id, tenant_id, name, home_venue, roster, staff
       FROM clubs WHERE club_id = $1`,
      [req.params.club_id]
    );
    if (result.rowCount === 0) {
      return fail(res, 404, 'NOT_FOUND', 'The requested club does not exist.');
    }
    const club = result.rows[0];
    if (!tenantAllowed(req.auth, club.tenant_id)) {
      return fail(res, 403, 'FORBIDDEN', 'This club is outside your tenant.');
    }
    return res.json({
      club_id: club.club_id,
      tenant_id: club.tenant_id,
      name: club.name,
      home_venue: club.home_venue,
      roster: club.roster,
      staff: club.staff
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/products', async (req, res, next) => {
  try {
    const result = req.auth.role === 'super_admin'
      ? await pool.query(
          `SELECT variant_id, product_id, price_minor, stock
           FROM variants ORDER BY product_id, variant_id`
        )
      : await pool.query(
          `SELECT variant_id, product_id, price_minor, stock
           FROM variants WHERE tenant_id = $1 ORDER BY product_id, variant_id`,
          [req.auth.tenant_id]
        );
    return res.json({ products: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/sync', handleOfflineSync);

module.exports = router;

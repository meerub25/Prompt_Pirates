const { verifyToken } = require('./jwt');
const { fail } = require('../util');

function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    return fail(res, 401, 'UNAUTHENTICATED', 'A valid Bearer token is required.');
  }
  try {
    req.auth = verifyToken(match[1]);
    return next();
  } catch {
    return fail(res, 401, 'UNAUTHENTICATED', 'The Bearer token is invalid or expired.');
  }
}

module.exports = { authenticate };

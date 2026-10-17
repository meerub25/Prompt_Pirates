const jwt = require('jsonwebtoken');

function jwtSecret() {
  const secret = process.env.DAY1_SALT;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('DAY1_SALT must be set to sign or verify application JWTs.');
  }
  return secret;
}

function signToken(claims, options = {}) {
  return jwt.sign(claims, jwtSecret(), {
    algorithm: 'HS256',
    expiresIn: options.expiresIn || '2h'
  });
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
}

module.exports = { signToken, verifyToken };

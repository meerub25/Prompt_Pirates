const crypto = require('node:crypto');

function hashPassword(email, password) {
  const salt = crypto.createHash('sha256').update(`nascon-demo:${email}`).digest('hex').slice(0, 32);
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(email, password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded).split('$');
  if (algorithm !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(expectedHex || '')) {
    return false;
  }
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };

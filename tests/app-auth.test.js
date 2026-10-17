const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../backend/auth/password');
const { signToken, verifyToken } = require('../backend/auth/jwt');

test('demo password hashes verify without storing the plaintext password', () => {
  const email = 'admin@nascon.test';
  const encoded = hashPassword(email, 'Nascon@26');
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(encoded.includes('Nascon@26'), false);
  assert.equal(verifyPassword(email, 'Nascon@26', encoded), true);
  assert.equal(verifyPassword(email, 'wrong', encoded), false);
});

test('shared JWT module signs and verifies HS256 application tokens', () => {
  const previous = process.env.DAY1_SALT;
  process.env.DAY1_SALT = 'unit-test-salt';
  try {
    const token = signToken({ sub: 'admin@nascon.test', role: 'super_admin' });
    const claims = verifyToken(token);
    assert.equal(claims.sub, 'admin@nascon.test');
    assert.equal(claims.role, 'super_admin');
    assert.throws(() => verifyToken(`${token.slice(0, -1)}x`));
  } finally {
    if (previous === undefined) delete process.env.DAY1_SALT;
    else process.env.DAY1_SALT = previous;
  }
});

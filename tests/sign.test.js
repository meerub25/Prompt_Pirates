const test = require('node:test');
const assert = require('node:assert/strict');
const { canonical, sign } = require('../backend/sign');

test('matches Appendix A HMAC-SHA256 test vector', () => {
  const originalSalt = process.env.DAY1_SALT;
  process.env.DAY1_SALT = 'demo-salt';
  try {
    assert.equal(
      sign('evt-1', { team_id: 't1', event_type: 'goal' }),
      '972a8b558690b19121cc5bea84978f85e8eb15a3735018db36616bab1d7ec501'
    );
  } finally {
    if (originalSalt === undefined) delete process.env.DAY1_SALT;
    else process.env.DAY1_SALT = originalSalt;
  }
});

test('canonical JSON recursively sorts keys without escaping non-ASCII text', () => {
  assert.equal(canonical({ z: 1, a: { b: 'é', a: 2 } }), '{"a":{"a":2,"b":"é"},"z":1}');
});

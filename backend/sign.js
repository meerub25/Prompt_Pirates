const crypto = require('crypto');

function compareCodePoints(left, right) {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return '{' + Object.keys(v).sort(compareCodePoints)
      .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function sign(id, payload) {
  return crypto.createHmac('sha256', process.env.DAY1_SALT)
    .update(id + '|' + canonical(payload), 'utf8').digest('hex');
}
module.exports = { canonical, sign };

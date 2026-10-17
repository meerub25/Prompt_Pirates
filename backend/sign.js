const crypto = require('crypto');

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return '{' + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function sign(id, payload) {
  return crypto.createHmac('sha256', process.env.DAY1_SALT)
    .update(id + '|' + canonical(payload), 'utf8').digest('hex');
}
module.exports = { canonical, sign };

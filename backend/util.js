function fail(res, status, code, message, details = {}) {
  return res.status(status).json({ error: { code, message, details } });
}
module.exports = { fail };

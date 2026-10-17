const { fail } = require('../util');

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendApiError(res, error) {
  return fail(res, error.status, error.code, error.message, error.details);
}

module.exports = { ApiError, sendApiError };

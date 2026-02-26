const { randomUUID } = require('crypto');

function shortId(len = 6) {
  return randomUUID().replace(/-/g, '').slice(0, len).toUpperCase();
}

function correlationId() {
  return randomUUID();
}

function logStructured(data) {
  console.log(JSON.stringify({ ...data, timestamp: new Date().toISOString() }));
}

module.exports = {
  shortId,
  correlationId,
  logStructured,
};

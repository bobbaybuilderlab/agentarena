const https = require('https');

const AMPLITUDE_API_KEY = process.env.AMPLITUDE_API_KEY || '';
const AMPLITUDE_URL = 'https://api2.amplitude.com/2/httpapi';

const eventQueue = [];
let flushTimer = null;

function track(eventType, userId, properties = {}) {
  if (!AMPLITUDE_API_KEY) return;

  eventQueue.push({
    event_type: eventType,
    user_id: userId || 'anonymous',
    event_properties: properties,
    time: Date.now(),
    platform: 'server',
  });

  if (!flushTimer) {
    flushTimer = setTimeout(flushEvents, 5000);
  }

  if (eventQueue.length >= 10) {
    flushEvents();
  }
}

function flushEvents() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (!eventQueue.length || !AMPLITUDE_API_KEY) return;

  const events = eventQueue.splice(0, eventQueue.length);
  const payload = JSON.stringify({ api_key: AMPLITUDE_API_KEY, events });

  const url = new URL(AMPLITUDE_URL);
  const req = https.request(
    {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    },
    (res) => {
      res.resume(); // drain response
      if (res.statusCode !== 200) {
        console.error(`Amplitude flush failed: ${res.statusCode}`);
      }
    }
  );
  req.on('error', (err) => console.error('Amplitude request error:', err.message));
  req.write(payload);
  req.end();
}

module.exports = { track, flushEvents };

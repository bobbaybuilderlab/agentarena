/**
 * Analytics tracking service
 */

function track(eventName, properties = {}) {
  // In production, this would send to an analytics service
  // For now, just log structured data
  if (process.env.NODE_ENV !== 'test') {
    console.log(JSON.stringify({
      event: eventName,
      properties,
      timestamp: new Date().toISOString(),
    }));
  }
}

module.exports = {
  track,
};

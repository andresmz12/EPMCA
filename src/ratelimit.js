// Small in-memory rate limiter (single Railway instance). Keys are usually IPs.
function limiter({ max, windowMs }) {
  const hits = new Map();
  const recent = (key, now) => (hits.get(key) || []).filter((t) => now - t < windowMs);
  setInterval(() => {
    const now = Date.now();
    for (const key of hits.keys()) {
      const a = recent(key, now);
      if (a.length) hits.set(key, a); else hits.delete(key);
    }
  }, windowMs).unref();
  return {
    blocked(key) { return recent(key, Date.now()).length >= max; },
    hit(key) { const now = Date.now(); hits.set(key, [...recent(key, now), now]); },
  };
}

module.exports = { limiter };

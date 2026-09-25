// Token auth for the mobile app's JSON API. The web store keeps using
// cookie sessions; native apps get a signed, long-lived bearer token instead
// (no cookie jar to manage, standard for mobile clients).
const jwt = require('jsonwebtoken');
const { isProd } = require('./env');

const SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
if (!process.env.JWT_SECRET && isProd) {
  console.error('Falta JWT_SECRET en producción (necesario para la app móvil).');
}

function signCustomerToken(customer) {
  return jwt.sign({ sub: customer.id, email: customer.email }, SECRET, { expiresIn: '180d' });
}

/** Populates req.customerId/req.customerEmail when a valid bearer token is present; never rejects by itself. */
function readToken(req, res, next) {
  const header = req.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(header);
  if (m) {
    try {
      const payload = jwt.verify(m[1], SECRET);
      req.customerId = payload.sub;
      req.customerEmail = payload.email;
    } catch { /* expired or invalid: treat as anonymous */ }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.customerId) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

module.exports = { signCustomerToken, readToken, requireAuth };

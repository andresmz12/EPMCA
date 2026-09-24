// Railway sets RAILWAY_ENVIRONMENT_NAME on every deploy, so a forgotten
// NODE_ENV there must not fall back to dev defaults (admin123, stack traces).
const isProd = process.env.NODE_ENV === 'production'
  || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);

module.exports = { isProd };

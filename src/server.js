const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const compression = require('compression');
const { pool, migrate, getSettings, one, all } = require('./db');
const lib = require('./lib');
const { makeT, LANGS } = require('./i18n');
const payments = require('./payments');
const clover = require('./clover');
const seo = require('./seo');
const notify = require('./notify');
const jobs = require('./jobs');
const { isProd } = require('./env');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
let canonicalHost = null;
try { canonicalHost = PUBLIC_URL ? new URL(PUBLIC_URL).host : null; } catch { console.warn('⚠️  PUBLIC_URL no es una URL válida; se ignora.'); }
// Changes on every deploy so browsers fetch the new CSS instead of a 7-day-old copy.
const ASSET_V = (process.env.RAILWAY_GIT_COMMIT_SHA || Date.now().toString(36)).slice(0, 8);
const siteUrlOf = (req) => (canonicalHost ? PUBLIC_URL : `${req.protocol}://${req.get('host')}`);

if (!process.env.SESSION_SECRET && isProd) {
  console.error('Falta SESSION_SECRET en producción.');
  process.exit(1);
}

app.set('trust proxy', 1); // Railway sits behind a proxy (needed for secure cookies)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
app.use(compression());

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProd) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// One canonical domain (e.g. the *.up.railway.app address and www redirect to
// PUBLIC_URL) so search engines don't see the same store twice.
app.use((req, res, next) => {
  if (!canonicalHost || req.method !== 'GET' || req.path === '/healthz' || req.get('host') === canonicalHost) return next();
  res.redirect(301, PUBLIC_URL + req.originalUrl);
});

// Payment webhooks need the raw body, so they're mounted before the JSON/urlencoded parsers.
app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), payments.webhook);
app.post('/clover/webhook', express.raw({ type: 'application/json', limit: '1mb' }), clover.webhook);

// CSRF defense in depth (on top of SameSite=Lax cookies): browsers always send
// Origin on cross-site POSTs, so reject any whose origin isn't this site.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host = null;
  try { host = new URL(origin).host; } catch { /* "null" or malformed */ }
  if (host !== req.get('host')) return res.status(403).send('Origen no permitido / Origin not allowed');
  next();
});

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: isProd ? '7d' : 0 }));

// Mounted before sessions so image/health requests don't hit the session store.
app.get('/healthz', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.get('/img/:id', async (req, res) => {
  const img = await one('SELECT mime, data FROM images WHERE id=$1', [lib.int(req.params.id)]);
  if (!img) return res.status(404).end();
  res.set('Content-Type', img.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(img.data);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /checkout',
    'Disallow: /order/',
    '',
    `Sitemap: ${siteUrlOf(req)}/sitemap.xml`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', async (req, res) => {
  const products = await all('SELECT slug, updated_at FROM products WHERE active ORDER BY sort, id');
  const newest = products.reduce((m, p) => (p.updated_at > m ? p.updated_at : m), new Date(0));
  const pages = [
    { path: '/', lastmod: products.length ? newest : null },
    ...products.map((p) => ({ path: `/products/${p.slug}`, lastmod: p.updated_at })),
    { path: '/track' },
    { path: '/contact' },
    { path: '/terms' },
    { path: '/privacy' },
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(seo.sitemap(siteUrlOf(req), pages));
});

app.use(
  session({
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);

// Shared template locals
app.use(async (req, res, next) => {
  const settings = await getSettings();
  // "?lang=es" is a real, crawlable URL for the Spanish version; the choice is
  // remembered in a plain cookie (not the session, so crawlers don't create sessions).
  let lang;
  if (LANGS.includes(req.query.lang)) {
    lang = req.query.lang;
    res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: isProd });
  } else {
    const fromCookie = /(?:^|;\s*)lang=(en|es)(?:;|$)/.exec(req.headers.cookie || '');
    lang = (fromCookie && fromCookie[1]) || req.session.lang || (/^es\b/i.test(req.get('accept-language') || '') ? 'es' : 'en');
  }
  const cart = req.session.cart || {};
  const siteUrl = siteUrlOf(req);
  notify.rememberBase(siteUrl);
  Object.assign(res.locals, {
    settings, lang, t: makeT(lang), money: lib.money, path: req.path, siteUrl, assetV: ASSET_V,
    altUrl: (l) => `${siteUrl}${req.path}${l === 'es' ? '?lang=es' : ''}`,
    cartCount: Object.values(cart).reduce((s, n) => s + (Number(n) || 0), 0),
    flash: req.session.flash || null, payEnabled: clover.enabled || payments.enabled, boxSvg: lib.boxSvg,
    customer: req.session.customer || null, US_STATES: lib.US_STATES, trackingUrl: lib.trackingUrl, wholesaleTiers: lib.wholesaleTiers, supplySvg: lib.supplySvg,
    cartAdded: req.session.cartAdded || null,
    // Product text in the visitor's language (falls back to English)
    pt: (p, f) => (lang === 'es' && p[f + '_es']) || p[f],
  });
  delete req.session.flash;
  delete req.session.cartAdded;
  next();
});

app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/store'));

app.use((req, res) => res.status(404).render('store/404', { noindex: true }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).send(isProd ? 'Something went wrong. / Algo salió mal.' : `<pre>${String(err.stack).replace(/</g, '&lt;')}</pre>`);
});

migrate()
  .then(() => {
    jobs.start();
    app.listen(PORT, (err) => {
      if (err) throw err;
      console.log(`Tienda lista en http://localhost:${PORT}  ·  Admin: /admin`);
    });
  })
  .catch((e) => {
    console.error('Error inicializando la base de datos:', e);
    process.exit(1);
  });

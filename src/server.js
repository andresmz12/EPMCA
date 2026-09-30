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
const live = require('./live');
const { limiter } = require('./ratelimit');
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

// Photos live in Postgres; keep the hot ones in memory so a traffic spike doesn't
// turn every image request into a database read (ids are immutable, so this is safe).
const imgCache = new Map();
let imgCacheBytes = 0;
const IMG_CACHE_MAX = 64 * 1024 * 1024;
app.get('/img/:id', async (req, res) => {
  const id = lib.int(req.params.id);
  let img = imgCache.get(id);
  if (img) { imgCache.delete(id); imgCache.set(id, img); }
  else {
    img = await one('SELECT mime, data FROM images WHERE id=$1', [id]);
    if (!img) return res.status(404).end();
    if (img.data.length < 4 * 1024 * 1024) {
      imgCache.set(id, img);
      imgCacheBytes += img.data.length;
      for (const [k, v] of imgCache) {
        if (imgCacheBytes <= IMG_CACHE_MAX) break;
        imgCache.delete(k);
        imgCacheBytes -= v.data.length;
      }
    }
  }
  res.set('Content-Type', img.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(img.data);
});

// Live-visitor heartbeat. Mounted before sessions so it never touches the session store.
const pingLimit = limiter({ max: 300, windowMs: 60 * 1000 });
app.post('/api/ping', async (req, res) => {
  if (pingLimit.blocked(req.ip)) return res.status(204).end();
  pingLimit.hit(req.ip);
  try { await live.ping(req.body, req.get('user-agent'), req.get('host')); } catch (e) { console.error('ping:', e.message); }
  res.status(204).end();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /img/',
    'Disallow: /admin',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /account',
    'Disallow: /order/',
    'Disallow: /track',
    'Disallow: /callback',
    '',
    `Sitemap: ${siteUrlOf(req)}/sitemap.xml`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', async (req, res) => {
  const products = await all('SELECT p.slug, p.updated_at, p.image_id, p.name FROM products p WHERE p.active ORDER BY p.sort, p.id');
  const newest = products.reduce((m, p) => (p.updated_at > m ? p.updated_at : m), new Date(0));
  const pages = [
    { path: '/', lastmod: products.length ? newest : null },
    ...products.map((p) => ({ path: `/products/${p.slug}`, lastmod: p.updated_at, image: p.image_id ? { id: p.image_id, title: p.name } : null })),
    { path: '/contact' },
    { path: '/terms' },
    { path: '/privacy' },
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(seo.sitemap(siteUrlOf(req), pages));
});

// Google Merchant Center product feed (free listings on Google Shopping).
// ?lang=es serves the Spanish version.
app.get('/feeds/google.xml', async (req, res) => {
  const lang = req.query.lang === 'es' ? 'es' : 'en';
  const [products, settings] = await Promise.all([all('SELECT * FROM products WHERE active ORDER BY sort, id'), getSettings()]);
  res.type('application/xml').set('Cache-Control', 'public, max-age=1800').send(seo.googleFeed({ siteUrl: siteUrlOf(req), settings, products, lang }));
});

app.get('/llms.txt', async (req, res) => {
  const [products, settings] = await Promise.all([all('SELECT slug, name, dimensions, price_cents FROM products WHERE active ORDER BY sort, id'), getSettings()]);
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.llmsTxt({ siteUrl: siteUrlOf(req), settings, products }));
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
    ga4: /^G-[A-Z0-9]{4,20}$/.test(settings.ga4_id) ? settings.ga4_id : '',
    adsId: /^AW-\d{5,15}$/.test(settings.google_ads_id) ? settings.google_ads_id : '',
    altUrl: (l) => `${siteUrl}${req.path}${l === 'es' ? '?lang=es' : ''}`,
    cartCount: Object.values(cart).reduce((s, n) => s + (Number(n) || 0), 0),
    flash: req.session.flash || null, payEnabled: clover.enabled || payments.enabled, recurringEnabled: clover.enabled, boxSvg: lib.boxSvg,
    customer: req.session.customer || null, US_STATES: lib.US_STATES, trackingUrl: lib.trackingUrl, wholesaleTiers: lib.wholesaleTiers, supplySvg: lib.supplySvg, supplyIcon: lib.supplyIcon,
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

// A failed background promise (email, job) must never take the whole store down.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

migrate()
  .then(() => {
    jobs.start();
    const server = app.listen(PORT, (err) => {
      if (err) throw err;
      console.log(`Tienda lista en http://localhost:${PORT}  ·  Admin: /admin`);
    });
    // Longer than the hosting proxy's idle timeout, so it never reuses a socket we just closed (random 502s).
    server.keepAliveTimeout = 65 * 1000;
    server.headersTimeout = 66 * 1000;
    server.requestTimeout = 60 * 1000;
    // Deploys send SIGTERM: stop taking new connections, let in-flight requests (checkouts!) finish.
    let closing = false;
    const shutdown = (sig) => {
      if (closing) return;
      closing = true;
      console.log(`${sig}: cerrando…`);
      server.close(() => pool.end().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((e) => {
    console.error('Error inicializando la base de datos:', e);
    process.exit(1);
  });

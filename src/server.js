const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const compression = require('compression');
const { pool, migrate, getSettings, one } = require('./db');
const lib = require('./lib');
const { makeT, LANGS } = require('./i18n');
const payments = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET && isProd) {
  console.error('Falta SESSION_SECRET en producción.');
  process.exit(1);
}

app.set('trust proxy', 1); // Railway sits behind a proxy (needed for secure cookies)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
app.use(compression());

// Stripe webhook needs the raw body, so it's mounted before the JSON/urlencoded parsers.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), payments.webhook);

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: isProd ? '7d' : 0 }));

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

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Shared template locals
app.use(async (req, res, next) => {
  const settings = await getSettings();
  if (req.query.lang && LANGS.includes(req.query.lang)) req.session.lang = req.query.lang;
  const lang = req.session.lang || (/^es\b/i.test(req.get('accept-language') || '') ? 'es' : 'en');
  const cart = req.session.cart || {};
  Object.assign(res.locals, {
    settings, lang, t: makeT(lang), money: lib.money, path: req.path,
    cartCount: Object.values(cart).reduce((s, n) => s + (Number(n) || 0), 0),
    flash: req.session.flash || null, stripeEnabled: payments.enabled, boxSvg: lib.boxSvg,
    customer: req.session.customer || null, US_STATES: lib.US_STATES,
    cartAdded: req.session.cartAdded || null,
    // Product text in the visitor's language (falls back to English)
    pt: (p, f) => (lang === 'es' && p[f + '_es']) || p[f],
  });
  delete req.session.flash;
  delete req.session.cartAdded;
  next();
});

app.get('/healthz', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.get('/img/:id', async (req, res) => {
  const img = await one('SELECT mime, data FROM images WHERE id=$1', [lib.int(req.params.id)]);
  if (!img) return res.status(404).end();
  res.set('Content-Type', img.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(img.data);
});

app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/store'));

app.use((req, res) => res.status(404).render('store/404'));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).send(isProd ? 'Something went wrong. / Algo salió mal.' : `<pre>${String(err.stack).replace(/</g, '&lt;')}</pre>`);
});

// Unpaid Stripe checkouts reserve stock; release it if they were abandoned (backup for the webhook).
async function releaseAbandoned() {
  const { all } = require('./db');
  const { cancelOrder } = require('./orders');
  const stale = await all(`SELECT id FROM orders WHERE status='pending' AND payment_method='stripe' AND created_at < now() - interval '2 hours'`);
  for (const o of stale) await cancelOrder(o.id);
}

migrate()
  .then(() => {
    setInterval(() => releaseAbandoned().catch((e) => console.error(e)), 10 * 60 * 1000).unref();
    app.listen(PORT, (err) => {
      if (err) throw err;
      console.log(`Tienda lista en http://localhost:${PORT}  ·  Admin: /admin`);
    });
  })
  .catch((e) => {
    console.error('Error inicializando la base de datos:', e);
    process.exit(1);
  });

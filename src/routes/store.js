const express = require('express');
const { all, one, q } = require('../db');
const lib = require('../lib');
const auth = require('../auth');
const orders = require('../orders');
const payments = require('../payments');
const clover = require('../clover');
const subscriptions = require('../subscriptions');
const { limiter } = require('../ratelimit');
const seo = require('../seo');
const notify = require('../notify');
const mail = require('../mail');
const crypto = require('crypto');

const r = express.Router();

const loginLimit = limiter({ max: 10, windowMs: 15 * 60 * 1000 });
const signupLimit = limiter({ max: 5, windowMs: 60 * 60 * 1000 });
const contactLimit = limiter({ max: 5, windowMs: 60 * 60 * 1000 });
const forgotLimit = limiter({ max: 5, windowMs: 60 * 60 * 1000 });
const trackLimit = limiter({ max: 10, windowMs: 15 * 60 * 1000 });
const cartLimit = limiter({ max: 60, windowMs: 10 * 60 * 1000 });
const checkoutLimit = limiter({ max: 20, windowMs: 60 * 60 * 1000 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const couponText = (t, msg) => (msg ? t(msg.key, msg.vars) : null);

// Private/per-visitor pages stay out of search results.
r.use(['/cart', '/checkout', '/account', '/order'], (req, res, next) => { res.locals.noindex = true; next(); });

// Only follow the Referer back if it points at this site (no open redirect).
function backTo(req) {
  try {
    const u = new URL(req.get('referer') || '');
    if (u.host === req.get('host')) return u.pathname + u.search;
  } catch { /* missing or malformed */ }
  return '/';
}

// The home page is the heaviest to render and the one ads and search send everyone to.
// Visitors with nothing personal on screen (no login, cart, flash or popup) all get the
// same HTML, so it's rendered once per language every few seconds instead of per request.
const homeCache = new Map();
const HOME_TTL_MS = 20 * 1000;
r.get('/', async (req, res, next) => {
  const { siteUrl, settings, t, money, lang, customer, flash, cartAdded, cartCount } = res.locals;
  const cacheable = !customer && !flash && !cartAdded && cartCount === 0 && Object.keys(req.query).every((k) => k === 'lang');
  const key = `${siteUrl}|${lang}`;
  const hit = cacheable && homeCache.get(key);
  if (hit && Date.now() - hit.at < HOME_TTL_MS) return res.send(hit.html);
  const products = await all('SELECT * FROM products WHERE active ORDER BY sort, id');
  res.render('store/home', {
    products, title: null, fullTitle: t('seo_home_title'), description: t('seo_home_desc'), jsonld: seo.homeLd({ siteUrl, settings, t, money }),
    callbackSent: req.query.callback === 'ok',
    callbackError: req.query.callback === 'err' ? t(req.query.k === 'too_many' ? 'err_too_many' : 'err_required') : null,
  }, (err, html) => {
    if (err) return next(err);
    if (cacheable) { if (homeCache.size > 8) homeCache.clear(); homeCache.set(key, { at: Date.now(), html }); }
    res.send(html);
  });
});

// Quick "call me back" lead capture: just name + phone, reuses the contact inbox.
r.post('/callback', async (req, res) => {
  const { t } = res.locals;
  const name = String(req.body.name || '').trim().slice(0, 200);
  const phone = String(req.body.phone || '').trim().slice(0, 60);
  const note = String(req.body.note || '').trim().slice(0, 500);
  // Bots fill the hidden "website" field; pretend it worked and drop it.
  if (req.body.website) return res.redirect('/?callback=ok#callback');
  if (contactLimit.blocked(req.ip)) return res.redirect('/?callback=err&k=too_many#callback');
  if (!name || !phone) return res.redirect('/?callback=err#callback');
  contactLimit.hit(req.ip);
  const message = note || t('callback_default_note');
  await q('INSERT INTO contact_messages(name, email, phone, message) VALUES($1,$2,$3,$4)', [name, '', phone, message]);
  notify.contactMessage({ name, email: '', phone, message });
  res.redirect('/?callback=ok#callback');
});

r.get('/products/:slug', async (req, res, next) => {
  const product = await one('SELECT * FROM products WHERE slug=$1 AND active', [req.params.slug]);
  if (!product) return next();
  const others = await all('SELECT * FROM products WHERE active AND id<>$1 AND category=$2 ORDER BY sort, id LIMIT 4', [product.id, product.category]);
  const extra = await all('SELECT image_id FROM product_images WHERE product_id=$1 ORDER BY sort, id', [product.id]);
  const images = [...(product.image_id ? [product.image_id] : []), ...extra.map((r) => r.image_id)];
  const { siteUrl, settings, pt, t, money, altUrl, lang } = res.locals;
  const name = pt(product, 'name');
  let description = [pt(product, 'short_desc'), product.dimensions, `${money(product.price_cents)} ${t('per_box')}`, t('info_ship_d')]
    .filter(Boolean).join(' · ');
  if (description.length > 155) description = `${description.slice(0, 155).replace(/\s+\S*$/, '')}…`;
  res.render('store/product', {
    product, others, images, title: name, description, ogType: 'product',
    ogImage: images.length ? `/img/${images[0]}` : null,
    jsonld: seo.productLd({ siteUrl, settings, product, images, pt, url: altUrl(lang) }),
  });
});

// Remembers a session's cart so an abandoned-cart email can go out later, once
// we know an address to send it to (account email, or one typed at checkout).
// Never blocks the response: a hiccup here shouldn't break adding to cart.
function saveCartSnapshot(req, lang) {
  const cart = req.session.cart || {};
  const sessionId = req.sessionID;
  if (!sessionId) return;
  if (!Object.keys(cart).length) {
    q('DELETE FROM cart_snapshots WHERE session_id=$1', [sessionId]).catch(() => {});
    return;
  }
  const customer = req.session.customer;
  q(
    `INSERT INTO cart_snapshots(session_id, customer_id, email, lang, items, updated_at, reminded_at)
     VALUES($1,$2,$3,$4,$5,now(),NULL)
     ON CONFLICT (session_id) DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       email = COALESCE(EXCLUDED.email, cart_snapshots.email),
       lang = EXCLUDED.lang, items = EXCLUDED.items, updated_at = now(), reminded_at = NULL`,
    [sessionId, customer ? customer.id : null, customer ? customer.email : null, lang === 'en' ? 'en' : 'es', JSON.stringify(cart)],
  ).catch((e) => console.error('Cart snapshot error:', e.message));
}

function clearCartSnapshot(req) {
  if (req.sessionID) q('DELETE FROM cart_snapshots WHERE session_id=$1', [req.sessionID]).catch(() => {});
}

r.post('/cart/add', async (req, res) => {
  if (cartLimit.blocked(req.ip)) return res.redirect(303, backTo(req));
  cartLimit.hit(req.ip);
  const id = lib.int(req.body.product_id);
  const qty = Math.max(1, Math.min(lib.int(req.body.qty, 1), 999));
  const p = await one('SELECT * FROM products WHERE id=$1 AND active', [id]);
  if (p && p.stock > 0) {
    const cart = req.session.cart || {};
    const newQty = Math.min((lib.int(cart[id]) || 0) + qty, p.stock, 999);
    cart[id] = newQty;
    req.session.cart = cart;
    // Reflects the actual per-box price for the cart's new total quantity
    // (wholesale tiers apply per size, not per add-to-cart click).
    if (req.body.next !== 'cart') req.session.cartAdded = { id: p.id, name: p.name, name_es: p.name_es, qty, price_cents: lib.unitPriceCents(p, newQty), image_id: p.image_id };
  }
  saveCartSnapshot(req, res.locals.lang);
  res.redirect(req.body.next === 'cart' ? '/cart' : backTo(req));
});

r.post('/cart/update', (req, res) => {
  const cart = req.session.cart || {};
  for (const [k, v] of Object.entries(req.body)) {
    const m = /^qty_(\d+)$/.exec(k);
    if (!m || !Object.hasOwn(cart, m[1])) continue;
    const q = Math.max(0, Math.min(lib.int(v), 999));
    if (q) cart[m[1]] = q; else delete cart[m[1]];
  }
  if (req.body.remove) delete cart[lib.int(req.body.remove)];
  req.session.cart = cart;
  saveCartSnapshot(req, res.locals.lang);
  res.redirect('/cart');
});

r.post('/cart/coupon', (req, res) => {
  const code = String(req.body.code || '').trim().slice(0, 40);
  req.session.coupon = req.body.clear ? null : code || null;
  res.redirect(req.body.back === 'checkout' ? '/checkout' : '/cart');
});

r.get('/cart', async (req, res) => {
  const priced = await lib.priceCart(req.session.cart, req.session.coupon, res.locals.settings);
  const couponMsg = couponText(res.locals.t, priced.couponMsg);
  res.render('store/cart', { priced, couponMsg, couponCode: req.session.coupon, title: res.locals.t('cart_title') });
});

function readForm(body) {
  const f = {};
  for (const k of ['name', 'email', 'phone', 'address1', 'address2', 'city', 'state', 'zip', 'notes']) {
    f[k] = String(body[k] || '').trim().slice(0, k === 'notes' ? 1000 : 200);
  }
  f.fulfillment = body.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  f.state = f.state.toUpperCase();
  return f;
}

function validate(f, settings) {
  if (!f.name || !f.email) return 'err_required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return 'err_email';
  if (f.fulfillment === 'pickup' && settings.pickup_enabled !== 'true') f.fulfillment = 'delivery';
  if (f.fulfillment === 'delivery') {
    if (!f.address1 || !f.city || !lib.US_STATES.includes(f.state)) return 'err_required';
    if (!/^\d{5}(-\d{4})?$/.test(f.zip)) return 'err_zip';
  } else {
    f.address1 = f.address2 = f.city = f.state = f.zip = '';
  }
  return null;
}

r.get('/checkout', async (req, res) => {
  const { settings, t, customer } = res.locals;
  const pickupOn = settings.pickup_enabled === 'true';
  let form = req.session.checkoutForm;
  if (!form) {
    form = customer
      ? { fulfillment: 'delivery', name: customer.name, email: customer.email, phone: customer.phone,
          address1: customer.address1, address2: customer.address2, city: customer.city, state: customer.state, zip: customer.zip }
      : { fulfillment: 'delivery', state: '' };
  }
  if (!pickupOn) form.fulfillment = 'delivery';
  const delivery = await lib.priceCart(req.session.cart, req.session.coupon, settings, 'delivery');
  if (!delivery.lines.length) return res.redirect('/cart');
  const pickup = pickupOn ? await lib.priceCart(req.session.cart, req.session.coupon, settings, 'pickup') : null;
  res.render('store/checkout', {
    delivery, pickup, form, error: req.session.checkoutError || null, states: lib.US_STATES,
    couponMsg: couponText(t, delivery.couponMsg), couponCode: req.session.coupon, title: t('checkout'),
  });
  delete req.session.checkoutError;
});

r.post('/checkout', async (req, res) => {
  const { settings, t, customer } = res.locals;
  const form = readForm(req.body);
  form.lang = res.locals.lang;
  req.session.checkoutForm = form;
  const fail = (key) => { req.session.checkoutError = t(key); res.redirect('/checkout'); };

  if (checkoutLimit.blocked(req.ip)) return fail('err_too_many');
  checkoutLimit.hit(req.ip);
  const err = validate(form, settings);
  if (err) return fail(err);
  // Lets a logged-in customer check the box and skip retyping their address next time,
  // instead of the separate "saved address" form in /account being the only way in.
  if (customer && form.fulfillment === 'delivery' && req.body.save_address) {
    q('UPDATE customers SET name=$1, phone=$2, address1=$3, address2=$4, city=$5, state=$6, zip=$7 WHERE id=$8',
      [form.name, form.phone, form.address1, form.address2, form.city, form.state, form.zip, customer.id]).catch(() => {});
  }
  const priced = await lib.priceCart(req.session.cart, req.session.coupon, settings, form.fulfillment);
  if (!priced.lines.length) return fail('err_empty');
  if (priced.lines.some((l) => l.overStock)) return fail('err_stock');

  const paymentMethod = clover.enabled ? 'clover' : (payments.enabled ? 'stripe' : 'manual');
  let order;
  try {
    order = await orders.createOrder({ priced, form, paymentMethod, customerId: customer ? customer.id : null });
  } catch (e) {
    if (e instanceof orders.StockError) return fail('err_stock');
    if (e instanceof orders.CouponUsedError) return fail('coupon_used');
    throw e;
  }

  if (paymentMethod !== 'manual') {
    try {
      const url = paymentMethod === 'clover' ? await clover.createCheckout(req, order, priced) : await payments.createCheckout(req, order, priced);
      req.session.pendingCart = req.session.cart; // restore if the customer cancels
      req.session.cart = {};
      req.session.coupon = null;
      clearCartSnapshot(req);
      return res.redirect(303, url);
    } catch (e) {
      console.error(`${paymentMethod} error:`, e.message);
      await orders.cancelOrder(order.id);
      return fail('err_payment');
    }
  }

  req.session.cart = {};
  req.session.coupon = null;
  clearCartSnapshot(req);
  notify.orderPlaced(order, res.locals.siteUrl);
  res.redirect(`/order/${order.number}?t=${order.access_token}`);
});

r.get('/checkout/cancel', async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE number=$1 AND access_token=$2', [String(req.query.o || ''), String(req.query.t || '')]);
  if (o && o.status === 'pending' && o.payment_method !== 'manual') await orders.cancelOrder(o.id);
  if (req.session.pendingCart) {
    req.session.cart = req.session.pendingCart;
    delete req.session.pendingCart;
    saveCartSnapshot(req, res.locals.lang);
  }
  req.session.flash = { type: 'warn', key: 'cancelled_payment' };
  res.redirect('/cart');
});

// Lets a guest's cart-abandonment reminder go out even if they never finish
// checkout: captures the email as soon as they type it, tied to their
// existing cart snapshot (a no-op if the cart is already empty by then).
r.post('/checkout/save-email', (req, res) => {
  if (cartLimit.blocked(req.ip)) return res.status(429).end();
  cartLimit.hit(req.ip);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  if (EMAIL_RE.test(email) && req.sessionID) {
    q('UPDATE cart_snapshots SET email=$1 WHERE session_id=$2', [email, req.sessionID]).catch(() => {});
  }
  res.status(204).end();
});

// Rebuilds a cart from an abandoned-cart email link: only items still active
// and in stock are restored, so a stale email never oversells.
r.get('/cart/restore', async (req, res) => {
  const ids = String(req.query.items || '').split(',').map((s) => lib.int(s.split(':')[0])).filter(Boolean);
  if (ids.length) {
    const qtyById = Object.fromEntries(String(req.query.items).split(',').map((s) => s.split(':').map(Number)));
    const products = await all('SELECT id, stock FROM products WHERE id = ANY($1::int[]) AND active', [ids]);
    const cart = req.session.cart || {};
    for (const p of products) {
      const qty = Math.max(0, Math.min(lib.int(qtyById[p.id]) || 1, p.stock, 999));
      if (qty) cart[p.id] = qty;
    }
    req.session.cart = cart;
  }
  res.redirect('/cart');
});

r.get('/order/:number', async (req, res, next) => {
  const { customer } = res.locals;
  let order = await one('SELECT * FROM orders WHERE number=$1 AND access_token=$2', [req.params.number, String(req.query.t || '')]);
  if (!order && customer) {
    order = await one(
      `SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id
       WHERE o.number=$1 AND o.customer_id=$2 AND o.created_at >= COALESCE(c.account_created_at, c.created_at)`,
      [req.params.number, customer.id]);
  }
  if (!order) return next();
  if (req.query.clover_checkout_id) {
    order = await clover.syncFromSession(order, String(req.query.clover_checkout_id), res.locals.siteUrl);
    delete req.session.pendingCart;
  } else if (req.query.session_id) {
    order = await payments.syncFromSession(order, String(req.query.session_id), res.locals.siteUrl);
    delete req.session.pendingCart;
  }
  const items = await all('SELECT oi.*, p.name_es FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id', [order.id]);
  res.render('store/order', { order, items, title: order.number });
});

/* ───────────── Track an order without an account ───────────── */
// Order number alone isn't enough (numbers are short and partly time-based):
// the visitor must also give the order's email or phone.
r.get('/track', (req, res) => {
  const { t } = res.locals;
  res.render('store/track', { error: null, form: { number: String(req.query.n || '').slice(0, 40) }, title: t('track_title'), description: t('track_sub') });
});

r.post('/track', async (req, res) => {
  const { t } = res.locals;
  let number = String(req.body.number || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 40);
  if (number && !number.startsWith('BX-')) number = `BX-${number.replace(/^BX/, '')}`;
  const contact = String(req.body.contact || '').trim().toLowerCase().slice(0, 200);
  const fail = (key, status = 400) => res.status(status).render('store/track', { error: t(key), form: { number, contact }, title: t('track_title'), description: t('track_sub') });
  if (trackLimit.blocked(req.ip)) return fail('err_too_many', 429);
  if (!number || !contact) return fail('err_required');
  const order = await one('SELECT number, access_token, email, phone FROM orders WHERE upper(number)=$1', [number]);
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const c = digits(contact), p = digits(order && order.phone), n = Math.min(10, c.length, p.length);
  const ok = order && ((order.email && order.email.toLowerCase() === contact) || (n >= 7 && c.slice(-n) === p.slice(-n)));
  if (!ok) {
    trackLimit.hit(req.ip);
    return fail('track_not_found', 404);
  }
  res.redirect(`/order/${order.number}?t=${order.access_token}`);
});

/* ───────────── Customer accounts ───────────── */
function customerSession(c) {
  return { id: c.id, email: c.email, name: c.name, phone: c.phone,
    address1: c.address1, address2: c.address2, city: c.city, state: c.state, zip: c.zip };
}

r.get('/account/register', (req, res) => {
  if (res.locals.customer) return res.redirect('/account');
  res.render('store/account_register', { error: null, form: {}, title: res.locals.t('account_create') });
});

r.post('/account/register', async (req, res, next) => {
  const { t } = res.locals;
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const name = String(req.body.name || '').trim().slice(0, 200);
  const password = String(req.body.password || '');
  const fail = (key, status = 400) => res.status(status).render('store/account_register', { error: t(key), form: { name, email }, title: t('account_create') });

  if (signupLimit.blocked(req.ip)) return fail('err_too_many', 429);
  if (!name || !email) return fail('err_required');
  if (!EMAIL_RE.test(email)) return fail('err_email');
  if (password.length < 8) return fail('err_password_len');
  signupLimit.hit(req.ip);
  const existing = await one('SELECT id, password_hash FROM customers WHERE email=$1', [email]);
  if (existing && existing.password_hash) return fail('err_account_exists');

  const hash = await auth.hashPassword(password);
  // Claiming a guest record: clear the phone it left behind, and only orders
  // placed from now on show up in the account (no email verification).
  const customer = existing
    ? await one(`UPDATE customers SET name=$1, password_hash=$2, phone='', account_created_at=now() WHERE id=$3 RETURNING *`, [name, hash, existing.id])
    : await one('INSERT INTO customers(email, name, password_hash, account_created_at) VALUES($1,$2,$3,now()) RETURNING *', [email, name, hash]);
  if (!existing) notify.welcome(customer, res.locals.lang, res.locals.siteUrl);
  const cart = req.session.cart, coupon = req.session.coupon, oldSessionId = req.sessionID;
  req.session.regenerate((err) => {
    if (err) return next(err);
    clearCartSnapshot({ sessionID: oldSessionId });
    req.session.customer = customerSession(customer);
    req.session.cart = cart;
    req.session.coupon = existing ? coupon : (coupon || 'WELCOME10');
    saveCartSnapshot(req, res.locals.lang);
    // Explicit save: without it, the browser's very next request can arrive
    // before the new session finishes writing and look logged out.
    req.session.save((err2) => (err2 ? next(err2) : res.redirect('/account')));
  });
});

r.get('/account/login', (req, res) => {
  if (res.locals.customer) return res.redirect('/account');
  res.render('store/account_login', { error: null, title: res.locals.t('account_login') });
});

r.post('/account/login', async (req, res, next) => {
  const { t } = res.locals;
  if (loginLimit.blocked(req.ip)) return res.status(429).render('store/account_login', { error: t('err_too_many'), title: t('account_login') });
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const customer = email ? await one('SELECT * FROM customers WHERE email=$1', [email]) : null;
  const ok = await auth.verifyPassword(req.body.password || '', customer && customer.password_hash);
  if (!ok) {
    loginLimit.hit(req.ip);
    return res.status(401).render('store/account_login', { error: t('err_login'), title: t('account_login') });
  }
  const cart = req.session.cart, coupon = req.session.coupon, oldSessionId = req.sessionID;
  req.session.regenerate((err) => {
    if (err) return next(err);
    clearCartSnapshot({ sessionID: oldSessionId });
    req.session.customer = customerSession(customer);
    req.session.cart = cart;
    req.session.coupon = coupon;
    saveCartSnapshot(req, res.locals.lang);
    // Explicit save: without it, the browser's very next request can arrive
    // before the new session finishes writing and look logged out.
    req.session.save((err2) => (err2 ? next(err2) : res.redirect('/account')));
  });
});

r.post('/account/logout', (req, res) => {
  delete req.session.customer;
  res.redirect('/');
});

r.get('/account', async (req, res) => {
  if (!res.locals.customer) return res.redirect('/account/login');
  const list = await all(
    `SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id
     WHERE o.customer_id=$1 AND o.created_at >= COALESCE(c.account_created_at, c.created_at)
     ORDER BY o.created_at DESC`, [res.locals.customer.id]);
  const subs = await all('SELECT * FROM subscriptions WHERE customer_id=$1 ORDER BY created_at DESC', [res.locals.customer.id]);
  const welcomeUsed = await one(
    `SELECT 1 FROM orders WHERE customer_id=$1 AND upper(coupon_code)='WELCOME10' AND status<>'cancelled' LIMIT 1`,
    [res.locals.customer.id]);
  res.render('store/account', {
    orders: list, subs, subJustCreated: req.query.sub === 'ok', showWelcomeCoupon: !welcomeUsed, title: res.locals.t('account_title'),
  });
});

// Copies a past order's items into the current cart, skipping anything no
// longer available, so a repeat customer doesn't have to re-pick every size.
r.post('/account/orders/:id/reorder', async (req, res) => {
  if (!res.locals.customer) return res.redirect('/account/login');
  const order = await one('SELECT id FROM orders WHERE id=$1 AND customer_id=$2', [lib.int(req.params.id), res.locals.customer.id]);
  if (!order) return res.redirect('/account');
  const items = await all('SELECT product_id, qty FROM order_items WHERE order_id=$1 AND product_id IS NOT NULL', [order.id]);
  const products = items.length ? await all('SELECT id, stock, active FROM products WHERE id = ANY($1::int[])', [items.map((i) => i.product_id)]) : [];
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const cart = req.session.cart || {};
  let skipped = false;
  for (const it of items) {
    const p = byId[it.product_id];
    if (!p || !p.active || p.stock <= 0) { skipped = true; continue; }
    cart[p.id] = Math.min((lib.int(cart[p.id]) || 0) + it.qty, p.stock, 999);
  }
  req.session.cart = cart;
  saveCartSnapshot(req, res.locals.lang);
  req.session.flash = { type: skipped ? 'warn' : 'ok', key: skipped ? 'reorder_partial' : 'reorder_ok' };
  res.redirect('/cart');
});

r.post('/account/subscribe', async (req, res) => {
  const { customer, settings } = res.locals;
  if (!customer) return res.redirect('/account/login');
  if (!clover.enabled) return res.redirect('/cart');
  const full = await one('SELECT * FROM customers WHERE id=$1', [customer.id]);
  if (!full.address1 || !full.city || !full.state || !full.zip) {
    req.session.flash = { type: 'warn', key: 'sub_need_address' };
    return res.redirect('/account');
  }
  const interval = req.body.interval === 'week' ? 'week' : 'month';
  const form = { fulfillment: 'delivery', name: full.name, email: full.email, phone: full.phone,
    address1: full.address1, address2: full.address2, city: full.city, state: full.state, zip: full.zip };
  const priced = await lib.priceCart(req.session.cart, null, settings, 'delivery');
  if (!priced.lines.length) return res.redirect('/cart');
  try {
    // First cycle is paid live, right now, just like a normal checkout; later
    // cycles are unattended and email the customer a link instead (see subscriptions.js).
    const { url } = await subscriptions.createPlan(full, priced, form, interval, res.locals.lang);
    req.session.cart = {};
    res.redirect(303, url);
  } catch (e) {
    console.error('Subscription setup error:', e.message);
    req.session.flash = { type: 'err', key: 'err_payment' };
    res.redirect('/cart');
  }
});

r.post('/account/subscriptions/:id/cancel', async (req, res) => {
  if (!res.locals.customer) return res.redirect('/account/login');
  const sub = await one('SELECT * FROM subscriptions WHERE id=$1 AND customer_id=$2', [lib.int(req.params.id), res.locals.customer.id]);
  if (sub) await subscriptions.cancel(sub);
  req.session.flash = { type: 'ok', key: 'sub_cancelled' };
  res.redirect('/account');
});

r.post('/account/address', async (req, res) => {
  if (!res.locals.customer) return res.redirect('/account/login');
  const f = {};
  for (const k of ['name', 'phone', 'address1', 'address2', 'city', 'state', 'zip']) f[k] = String(req.body[k] || '').trim().slice(0, 200);
  f.state = f.state.toUpperCase();
  const bad = (f.state && !lib.US_STATES.includes(f.state)) ? 'err_required' : (f.zip && !/^\d{5}(-\d{4})?$/.test(f.zip)) ? 'err_zip' : null;
  if (bad) {
    req.session.flash = { type: 'err', key: bad };
    return res.redirect('/account');
  }
  const customer = await one(
    'UPDATE customers SET name=$1, phone=$2, address1=$3, address2=$4, city=$5, state=$6, zip=$7 WHERE id=$8 RETURNING *',
    [f.name, f.phone, f.address1, f.address2, f.city, f.state, f.zip, res.locals.customer.id]);
  req.session.customer = customerSession(customer);
  req.session.flash = { type: 'ok', key: 'account_saved' };
  res.redirect('/account');
});

/* ───────────── Legal ───────────── */
r.get('/terms', (req, res) => {
  const { t } = res.locals;
  res.render('store/terms', { title: t('terms_title'), description: t('terms_title') });
});

r.get('/privacy', (req, res) => {
  const { t } = res.locals;
  res.render('store/privacy', { title: t('privacy_title'), description: t('privacy_title') });
});

/* ───────────── Contact ───────────── */
r.get('/contact', (req, res) => {
  const { customer, t } = res.locals;
  const form = customer ? { name: customer.name, email: customer.email, phone: customer.phone } : {};
  res.render('store/contact', { error: null, sent: false, form, title: t('contact_title'), description: t('contact_sub') });
});

r.post('/contact', async (req, res) => {
  const { t } = res.locals;
  const form = {
    name: String(req.body.name || '').trim().slice(0, 200),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    phone: String(req.body.phone || '').trim().slice(0, 60),
    message: String(req.body.message || '').trim().slice(0, 3000),
  };
  const fail = (key, status = 400) => res.status(status).render('store/contact', { error: t(key), sent: false, form, title: t('contact_title') });
  // Bots fill the hidden "website" field; pretend it worked and drop it.
  if (req.body.website) return res.render('store/contact', { error: null, sent: true, form: {}, title: t('contact_title') });
  if (contactLimit.blocked(req.ip)) return fail('err_too_many', 429);
  if (!form.name || !form.email || !form.message) return fail('err_required');
  if (!EMAIL_RE.test(form.email)) return fail('err_email');
  contactLimit.hit(req.ip);
  await q('INSERT INTO contact_messages(name, email, phone, message) VALUES($1,$2,$3,$4)', [form.name, form.email, form.phone, form.message]);
  notify.contactMessage(form);
  res.render('store/contact', { error: null, sent: true, form: {}, title: t('contact_title') });
});

/* ───────────── Password reset ───────────── */
const hashToken = (tok) => crypto.createHash('sha256').update(tok).digest('hex');

r.get('/account/forgot', (req, res) => {
  const { t } = res.locals;
  res.render('store/account_forgot', { sent: false, error: mail.enabled ? null : t('forgot_unavailable'), title: t('forgot_title'), noindex: true });
});

r.post('/account/forgot', async (req, res) => {
  const { t, siteUrl, lang } = res.locals;
  const render = (o) => res.render('store/account_forgot', { sent: false, error: null, title: t('forgot_title'), noindex: true, ...o });
  if (!mail.enabled) return render({ error: t('forgot_unavailable') });
  if (forgotLimit.blocked(req.ip)) return render({ error: t('err_too_many') });
  forgotLimit.hit(req.ip);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const customer = EMAIL_RE.test(email) ? await one('SELECT * FROM customers WHERE email=$1 AND password_hash IS NOT NULL', [email]) : null;
  if (customer) {
    const token = crypto.randomBytes(32).toString('base64url');
    await q("INSERT INTO password_resets(token_hash, customer_id, expires_at) VALUES($1,$2, now() + interval '1 hour')", [hashToken(token), customer.id]);
    notify.passwordReset(customer, `${siteUrl}/account/reset/${token}`, lang);
  }
  // Same answer either way, so this form can't be used to find out who has an account.
  render({ sent: true });
});

const validReset = (token) => one(
  'SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [hashToken(String(token))]);

r.get('/account/reset/:token', async (req, res) => {
  const { t } = res.locals;
  const ok = await validReset(req.params.token);
  res.render('store/account_reset', { token: ok ? req.params.token : null, error: ok ? null : t('reset_invalid'), title: t('reset_title'), noindex: true });
});

r.post('/account/reset/:token', async (req, res) => {
  const { t } = res.locals;
  const row = await validReset(req.params.token);
  if (!row) return res.status(400).render('store/account_reset', { token: null, error: t('reset_invalid'), title: t('reset_title'), noindex: true });
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).render('store/account_reset', { token: req.params.token, error: t('err_password_len'), title: t('reset_title'), noindex: true });
  await q('UPDATE customers SET password_hash=$1 WHERE id=$2', [await auth.hashPassword(password), row.customer_id]);
  await q('UPDATE password_resets SET used_at=now() WHERE customer_id=$1 AND used_at IS NULL', [row.customer_id]);
  req.session.flash = { type: 'ok', key: 'reset_done' };
  res.redirect('/account/login');
});

module.exports = r;

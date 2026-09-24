const express = require('express');
const { all, one, q } = require('../db');
const lib = require('../lib');
const auth = require('../auth');
const orders = require('../orders');
const payments = require('../payments');
const subscriptions = require('../subscriptions');

const r = express.Router();

const couponText = (t, msg) => (msg ? t(msg.key, msg.vars) : null);

r.get('/', async (req, res) => {
  const products = await all('SELECT * FROM products WHERE active ORDER BY sort, id');
  res.render('store/home', { products, title: null });
});

r.get('/products/:slug', async (req, res, next) => {
  const product = await one('SELECT * FROM products WHERE slug=$1 AND active', [req.params.slug]);
  if (!product) return next();
  const others = await all('SELECT * FROM products WHERE active AND id<>$1 ORDER BY sort, id LIMIT 4', [product.id]);
  const extra = await all('SELECT image_id FROM product_images WHERE product_id=$1 ORDER BY sort, id', [product.id]);
  const images = [...(product.image_id ? [product.image_id] : []), ...extra.map((r) => r.image_id)];
  res.render('store/product', { product, others, images, title: product.name });
});

r.post('/cart/add', async (req, res) => {
  const id = lib.int(req.body.product_id);
  const qty = Math.max(1, Math.min(lib.int(req.body.qty, 1), 999));
  const p = await one('SELECT id, name, name_es, price_cents, image_id, stock FROM products WHERE id=$1 AND active', [id]);
  if (p && p.stock > 0) {
    const cart = req.session.cart || {};
    cart[id] = Math.min((lib.int(cart[id]) || 0) + qty, p.stock, 999);
    req.session.cart = cart;
    if (req.body.next !== 'cart') req.session.cartAdded = { name: p.name, name_es: p.name_es, qty, price_cents: p.price_cents, image_id: p.image_id };
  }
  res.redirect(req.body.next === 'cart' ? '/cart' : req.get('referer') || '/');
});

r.post('/cart/update', (req, res) => {
  const cart = req.session.cart || {};
  for (const [k, v] of Object.entries(req.body)) {
    const m = /^qty_(\d+)$/.exec(k);
    if (!m) continue;
    const q = Math.max(0, Math.min(lib.int(v), 999));
    if (q) cart[m[1]] = q; else delete cart[m[1]];
  }
  if (req.body.remove) delete cart[lib.int(req.body.remove)];
  req.session.cart = cart;
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
  const { settings, t } = res.locals;
  const form = readForm(req.body);
  req.session.checkoutForm = form;
  const fail = (key) => { req.session.checkoutError = t(key); res.redirect('/checkout'); };

  const err = validate(form, settings);
  if (err) return fail(err);
  const priced = await lib.priceCart(req.session.cart, req.session.coupon, settings, form.fulfillment);
  if (!priced.lines.length) return fail('err_empty');
  if (priced.lines.some((l) => l.overStock)) return fail('err_stock');

  let order;
  try {
    order = await orders.createOrder({ priced, form, paymentMethod: payments.enabled ? 'stripe' : 'manual' });
  } catch (e) {
    if (e instanceof orders.StockError) return fail('err_stock');
    throw e;
  }

  if (payments.enabled) {
    try {
      const url = await payments.createCheckout(req, order, priced);
      req.session.pendingCart = req.session.cart; // restore if the customer cancels
      req.session.cart = {};
      req.session.coupon = null;
      return res.redirect(303, url);
    } catch (e) {
      console.error('Stripe error:', e.message);
      await orders.cancelOrder(order.id);
      return fail('err_payment');
    }
  }

  req.session.cart = {};
  req.session.coupon = null;
  res.redirect(`/order/${order.number}?t=${order.access_token}`);
});

r.get('/checkout/cancel', async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE number=$1 AND access_token=$2', [String(req.query.o || ''), String(req.query.t || '')]);
  if (o && o.status === 'pending' && o.payment_method === 'stripe') await orders.cancelOrder(o.id);
  if (req.session.pendingCart) {
    req.session.cart = req.session.pendingCart;
    delete req.session.pendingCart;
  }
  req.session.flash = { type: 'warn', key: 'cancelled_payment' };
  res.redirect('/cart');
});

r.get('/order/:number', async (req, res, next) => {
  const { customer } = res.locals;
  let order = await one('SELECT * FROM orders WHERE number=$1 AND access_token=$2', [req.params.number, String(req.query.t || '')]);
  if (!order && customer) order = await one('SELECT * FROM orders WHERE number=$1 AND customer_id=$2', [req.params.number, customer.id]);
  if (!order) return next();
  if (req.query.session_id) {
    order = await payments.syncFromSession(order, String(req.query.session_id));
    delete req.session.pendingCart;
  }
  const items = await all('SELECT oi.*, p.name_es FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id', [order.id]);
  res.render('store/order', { order, items, title: order.number });
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

r.post('/account/register', async (req, res) => {
  const { t } = res.locals;
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 200);
  const password = String(req.body.password || '');
  const fail = (key) => res.status(400).render('store/account_register', { error: t(key), form: { name, email }, title: t('account_create') });

  if (!name || !email) return fail('err_required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('err_email');
  if (password.length < 8) return fail('err_password_len');
  const existing = await one('SELECT id, password_hash FROM customers WHERE email=$1', [email]);
  if (existing && existing.password_hash) return fail('err_account_exists');

  const hash = auth.hashPassword(password);
  const isNew = !existing;
  const customer = existing
    ? await one('UPDATE customers SET name=$1, password_hash=$2 WHERE id=$3 RETURNING *', [name, hash, existing.id])
    : await one('INSERT INTO customers(email, name, password_hash) VALUES($1,$2,$3) RETURNING *', [email, name, hash]);
  const cart = req.session.cart, coupon = req.session.coupon;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.customer = customerSession(customer);
    req.session.cart = cart;
    req.session.coupon = isNew ? (coupon || 'WELCOME10') : coupon;
    res.redirect('/account');
  });
});

r.get('/account/login', (req, res) => {
  if (res.locals.customer) return res.redirect('/account');
  res.render('store/account_login', { error: null, title: res.locals.t('account_login') });
});

r.post('/account/login', async (req, res) => {
  const { t } = res.locals;
  const email = String(req.body.email || '').trim().toLowerCase();
  const customer = email && (await one('SELECT * FROM customers WHERE email=$1', [email]));
  const ok = customer && auth.verifyPassword(req.body.password || '', customer.password_hash);
  if (!ok) return res.status(401).render('store/account_login', { error: t('err_login'), title: t('account_login') });
  const cart = req.session.cart, coupon = req.session.coupon;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.customer = customerSession(customer);
    req.session.cart = cart;
    req.session.coupon = coupon;
    res.redirect('/account');
  });
});

r.post('/account/logout', (req, res) => {
  delete req.session.customer;
  res.redirect('/');
});

r.get('/account', async (req, res) => {
  if (!res.locals.customer) return res.redirect('/account/login');
  if (req.query.session_id) await subscriptions.syncFromSession(String(req.query.session_id));
  const list = await all('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC', [res.locals.customer.id]);
  const subs = await all('SELECT * FROM subscriptions WHERE customer_id=$1 ORDER BY created_at DESC', [res.locals.customer.id]);
  res.render('store/account', { orders: list, subs, subJustCreated: req.query.sub === 'ok', title: res.locals.t('account_title') });
});

r.post('/account/subscribe', async (req, res) => {
  const { customer, settings, t } = res.locals;
  if (!customer) return res.redirect('/account/login');
  if (!payments.enabled) return res.redirect('/cart');
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
    const url = await subscriptions.createCheckout(req, full, priced, form, interval);
    res.redirect(303, url);
  } catch (e) {
    console.error('Subscription checkout error:', e.message);
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
  const customer = await one(
    'UPDATE customers SET name=$1, phone=$2, address1=$3, address2=$4, city=$5, state=$6, zip=$7 WHERE id=$8 RETURNING *',
    [f.name, f.phone, f.address1, f.address2, f.city, f.state, f.zip, res.locals.customer.id]);
  req.session.customer = customerSession(customer);
  req.session.flash = { type: 'ok', key: 'account_saved' };
  res.redirect('/account');
});

/* ───────────── Contact ───────────── */
r.get('/contact', (req, res) => {
  const { customer, t } = res.locals;
  const form = customer ? { name: customer.name, email: customer.email, phone: customer.phone } : {};
  res.render('store/contact', { error: null, sent: false, form, title: t('contact_title') });
});

r.post('/contact', async (req, res) => {
  const { t } = res.locals;
  const form = {
    name: String(req.body.name || '').trim().slice(0, 200),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    phone: String(req.body.phone || '').trim().slice(0, 60),
    message: String(req.body.message || '').trim().slice(0, 3000),
  };
  if (!form.name || !form.email || !form.message) {
    return res.status(400).render('store/contact', { error: t('err_required'), sent: false, form, title: t('contact_title') });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    return res.status(400).render('store/contact', { error: t('err_email'), sent: false, form, title: t('contact_title') });
  }
  await q('INSERT INTO contact_messages(name, email, phone, message) VALUES($1,$2,$3,$4)', [form.name, form.email, form.phone, form.message]);
  res.render('store/contact', { error: null, sent: true, form: {}, title: t('contact_title') });
});

module.exports = r;

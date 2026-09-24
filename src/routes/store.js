const express = require('express');
const { all, one } = require('../db');
const lib = require('../lib');
const orders = require('../orders');
const payments = require('../payments');

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
  res.render('store/product', { product, others, title: product.name });
});

r.post('/cart/add', async (req, res) => {
  const id = lib.int(req.body.product_id);
  const qty = Math.max(1, Math.min(lib.int(req.body.qty, 1), 999));
  const p = await one('SELECT id, stock FROM products WHERE id=$1 AND active', [id]);
  if (p && p.stock > 0) {
    const cart = req.session.cart || {};
    cart[id] = Math.min((lib.int(cart[id]) || 0) + qty, p.stock, 999);
    req.session.cart = cart;
    req.session.flash = { type: 'ok', key: 'added' };
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
  const { settings, t } = res.locals;
  const pickupOn = settings.pickup_enabled === 'true';
  const form = req.session.checkoutForm || { fulfillment: 'delivery', state: '' };
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
  let order = await one('SELECT * FROM orders WHERE number=$1 AND access_token=$2', [req.params.number, String(req.query.t || '')]);
  if (!order) return next();
  if (req.query.session_id) {
    order = await payments.syncFromSession(order, String(req.query.session_id));
    delete req.session.pendingCart;
  }
  const items = await all('SELECT oi.*, p.name_es FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id', [order.id]);
  res.render('store/order', { order, items, title: order.number });
});

module.exports = r;

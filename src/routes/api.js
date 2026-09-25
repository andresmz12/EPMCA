// JSON API for the native (React Native) app. The web store keeps using
// server-rendered EJS + cookie sessions; this is a separate, stateless
// surface over the same business logic (lib/orders/auth/payments/notify).
const express = require('express');
const { all, one } = require('../db');
const lib = require('../lib');
const auth = require('../auth');
const apiAuth = require('../apiAuth');
const orders = require('../orders');
const payments = require('../payments');
const notify = require('../notify');
const { limiter } = require('../ratelimit');

const r = express.Router();
r.use(express.json());
r.use(apiAuth.readToken);

const loginLimit = limiter({ max: 10, windowMs: 15 * 60 * 1000 });
const signupLimit = limiter({ max: 5, windowMs: 60 * 60 * 1000 });
const checkoutLimit = limiter({ max: 20, windowMs: 60 * 60 * 1000 });
const trackLimit = limiter({ max: 10, windowMs: 15 * 60 * 1000 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const productOut = (p, lang) => ({
  id: p.id,
  slug: p.slug,
  name: (lang === 'es' && p.name_es) || p.name,
  shortDesc: (lang === 'es' && p.short_desc_es) || p.short_desc,
  description: (lang === 'es' && p.description_es) || p.description,
  dimensions: p.dimensions,
  packSize: p.pack_size,
  priceCents: p.price_cents,
  compareAtCents: p.compare_at_cents,
  stock: p.stock,
  featured: p.featured,
  imageUrl: p.image_id ? `/img/${p.image_id}` : null,
});

const customerOut = (c) => ({
  id: c.id, email: c.email, name: c.name, phone: c.phone,
  address1: c.address1, address2: c.address2, city: c.city, state: c.state, zip: c.zip,
});

/* ───────────── Catalog ───────────── */

r.get('/products', async (req, res) => {
  const lang = req.query.lang === 'es' ? 'es' : 'en';
  const products = await all('SELECT * FROM products WHERE active ORDER BY sort, id');
  res.json(products.map((p) => productOut(p, lang)));
});

r.get('/products/:slug', async (req, res) => {
  const lang = req.query.lang === 'es' ? 'es' : 'en';
  const product = await one('SELECT * FROM products WHERE slug=$1 AND active', [req.params.slug]);
  if (!product) return res.status(404).json({ error: 'not_found' });
  const gallery = await all('SELECT image_id FROM product_images WHERE product_id=$1 ORDER BY sort, id', [product.id]);
  res.json({ ...productOut(product, lang), images: gallery.map((g) => `/img/${g.image_id}`) });
});

/* ───────────── Account ───────────── */

r.post('/account/register', async (req, res) => {
  if (signupLimit.blocked(req.ip)) return res.status(429).json({ error: 'too_many' });
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const name = String(req.body.name || '').trim().slice(0, 200);
  const password = String(req.body.password || '');
  if (!name || !email) return res.status(400).json({ error: 'required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });
  signupLimit.hit(req.ip);

  const existing = await one('SELECT id, password_hash FROM customers WHERE email=$1', [email]);
  if (existing && existing.password_hash) return res.status(409).json({ error: 'account_exists' });
  const hash = await auth.hashPassword(password);
  const customer = existing
    ? await one(`UPDATE customers SET name=$1, password_hash=$2, phone='', account_created_at=now() WHERE id=$3 RETURNING *`, [name, hash, existing.id])
    : await one('INSERT INTO customers(email, name, password_hash, account_created_at) VALUES($1,$2,$3,now()) RETURNING *', [email, name, hash]);
  if (!existing) notify.welcome(customer, req.query.lang === 'es' ? 'es' : 'en');
  res.status(201).json({ token: apiAuth.signCustomerToken(customer), customer: customerOut(customer) });
});

r.post('/account/login', async (req, res) => {
  if (loginLimit.blocked(req.ip)) return res.status(429).json({ error: 'too_many' });
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const customer = email ? await one('SELECT * FROM customers WHERE email=$1', [email]) : null;
  const ok = await auth.verifyPassword(req.body.password || '', customer && customer.password_hash);
  if (!ok) {
    loginLimit.hit(req.ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  res.json({ token: apiAuth.signCustomerToken(customer), customer: customerOut(customer) });
});

r.get('/account/me', apiAuth.requireAuth, async (req, res) => {
  const customer = await one('SELECT * FROM customers WHERE id=$1', [req.customerId]);
  if (!customer) return res.status(404).json({ error: 'not_found' });
  res.json(customerOut(customer));
});

r.put('/account/address', apiAuth.requireAuth, async (req, res) => {
  const f = {};
  for (const k of ['name', 'phone', 'address1', 'address2', 'city', 'state', 'zip']) f[k] = String(req.body[k] || '').trim().slice(0, 200);
  const customer = await one(
    `UPDATE customers SET name=COALESCE(NULLIF($1,''),name), phone=$2, address1=$3, address2=$4, city=$5, state=$6, zip=$7 WHERE id=$8 RETURNING *`,
    [f.name, f.phone, f.address1, f.address2, f.city, f.state.toUpperCase(), f.zip, req.customerId]);
  res.json(customerOut(customer));
});

/* ───────────── Orders ───────────── */

r.get('/orders', apiAuth.requireAuth, async (req, res) => {
  const list = await all(
    `SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id
     WHERE o.customer_id=$1 AND o.created_at >= COALESCE(c.account_created_at, c.created_at)
     ORDER BY o.created_at DESC LIMIT 100`, [req.customerId]);
  res.json(list.map(orderOut));
});

function orderOut(o) {
  return {
    number: o.number, status: o.status, createdAt: o.created_at,
    fulfillment: o.fulfillment, name: o.name, address1: o.address1, address2: o.address2,
    city: o.city, state: o.state, zip: o.zip, tracking: o.tracking,
    subtotalCents: o.subtotal_cents, discountCents: o.discount_cents, shippingCents: o.shipping_cents,
    taxCents: o.tax_cents, totalCents: o.total_cents, notes: o.notes,
  };
}

r.get('/orders/:number', async (req, res) => {
  let order = await one('SELECT * FROM orders WHERE number=$1 AND access_token=$2', [req.params.number, String(req.query.t || '')]);
  if (!order && req.customerId) {
    order = await one(
      `SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id
       WHERE o.number=$1 AND o.customer_id=$2 AND o.created_at >= COALESCE(c.account_created_at, c.created_at)`,
      [req.params.number, req.customerId]);
  }
  if (!order) return res.status(404).json({ error: 'not_found' });
  const items = await all('SELECT name, unit_price_cents, qty FROM order_items WHERE order_id=$1 ORDER BY id', [order.id]);
  res.json({ ...orderOut(order), accessToken: order.access_token, items });
});

r.post('/track', async (req, res) => {
  if (trackLimit.blocked(req.ip)) return res.status(429).json({ error: 'too_many' });
  let number = String(req.body.number || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 40);
  if (number && !number.startsWith('BX-')) number = `BX-${number.replace(/^BX/, '')}`;
  const contact = String(req.body.contact || '').trim().toLowerCase().slice(0, 200);
  if (!number || !contact) return res.status(400).json({ error: 'required' });
  const order = await one('SELECT number, access_token, email, phone FROM orders WHERE upper(number)=$1', [number]);
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const c = digits(contact), p = digits(order && order.phone), n = Math.min(10, c.length, p.length);
  const ok = order && ((order.email && order.email.toLowerCase() === contact) || (n >= 7 && c.slice(-n) === p.slice(-n)));
  if (!ok) {
    trackLimit.hit(req.ip);
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ number: order.number, accessToken: order.access_token });
});

/* ───────────── Checkout ─────────────
 * The app sends its whole cart ({productId: qty}) since it keeps the cart in
 * local state, not a server session. Stock is priced and reserved the same
 * way as the web checkout (lib.priceCart + orders.createOrder). With Stripe
 * enabled we return a hosted Checkout URL (Apple Pay / Google Pay included
 * automatically); the app opens it in an in-app browser and matches the
 * deep-link redirect below to know when it's done. */
r.post('/checkout', async (req, res) => {
  if (checkoutLimit.blocked(req.ip)) return res.status(429).json({ error: 'too_many' });
  checkoutLimit.hit(req.ip);
  const { getSettings } = require('../db');
  const settings = await getSettings();
  const cart = req.body.cart && typeof req.body.cart === 'object' ? req.body.cart : {};
  const form = {};
  for (const k of ['name', 'email', 'phone', 'address1', 'address2', 'city', 'state', 'zip', 'notes']) {
    form[k] = String(req.body[k] || '').trim().slice(0, k === 'notes' ? 1000 : 200);
  }
  form.fulfillment = req.body.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  form.state = form.state.toUpperCase();
  form.lang = req.query.lang === 'es' ? 'es' : 'en';

  if (!form.name || !form.email) return res.status(400).json({ error: 'required' });
  if (!EMAIL_RE.test(form.email)) return res.status(400).json({ error: 'invalid_email' });
  if (form.fulfillment === 'pickup' && settings.pickup_enabled !== 'true') form.fulfillment = 'delivery';
  if (form.fulfillment === 'delivery') {
    if (!form.address1 || !form.city || !lib.US_STATES.includes(form.state)) return res.status(400).json({ error: 'required' });
    if (!/^\d{5}(-\d{4})?$/.test(form.zip)) return res.status(400).json({ error: 'invalid_zip' });
  } else {
    form.address1 = form.address2 = form.city = form.state = form.zip = '';
  }

  const priced = await lib.priceCart(cart, req.body.coupon || null, settings, form.fulfillment);
  if (!priced.lines.length) return res.status(400).json({ error: 'empty_cart' });
  if (priced.lines.some((l) => l.overStock)) return res.status(409).json({ error: 'out_of_stock' });

  let order;
  try {
    order = await orders.createOrder({ priced, form, paymentMethod: payments.enabled ? 'stripe' : 'manual', customerId: req.customerId || null });
  } catch (e) {
    if (e instanceof orders.StockError) return res.status(409).json({ error: 'out_of_stock' });
    if (e instanceof orders.CouponUsedError) return res.status(409).json({ error: 'coupon_used' });
    throw e;
  }

  if (payments.enabled) {
    const scheme = req.get('x-app-scheme') || 'empacalo';
    try {
      const url = await payments.createCheckout(req, order, priced, {
        success: `${scheme}://order-success?number=${order.number}&t=${order.access_token}`,
        cancel: `${scheme}://order-cancelled?number=${order.number}&t=${order.access_token}`,
      });
      return res.json({ order: orderOut(order), checkoutUrl: url });
    } catch (e) {
      console.error('Stripe error:', e.message);
      await orders.cancelOrder(order.id);
      return res.status(502).json({ error: 'payment_error' });
    }
  }

  notify.orderPlaced(order);
  res.status(201).json({ order: { ...orderOut(order), accessToken: order.access_token } });
});

module.exports = r;

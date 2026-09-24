const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { q, one, all, tx } = require('../db');
const lib = require('../lib');
const orders = require('../orders');

const r = express.Router();
const isProd = process.env.NODE_ENV === 'production';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || (isProd ? '' : 'admin@empacalo.net')).toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProd ? '' : 'admin123');
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) console.warn('⚠️  Define ADMIN_EMAIL y ADMIN_PASSWORD para poder entrar al panel.');
else if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  Usando credenciales de admin de desarrollo (admin@empacalo.net / admin123).');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// Basic brute-force protection: 8 failed attempts per IP per 15 min.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 8;
}

// Reject cross-site form posts (extra layer on top of SameSite cookies).
r.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) return res.status(403).send('Origen no permitido');
  next();
});

r.use((req, res, next) => {
  res.locals.STATUS = lib.STATUS_ES;
  res.locals.fmtDate = (d, time = true) => d ? new Date(d).toLocaleString('es-US', { timeZone: 'America/Chicago', dateStyle: 'medium', ...(time ? { timeStyle: 'short' } : {}) }) : '—';
  res.locals.admin = req.session.admin || null;
  res.locals.notice = req.session.notice || null;
  delete req.session.notice;
  res.set('Cache-Control', 'no-store');
  next();
});

r.get('/login', (req, res) => res.render('admin/login', { error: null }));

r.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).render('admin/login', { error: 'Demasiados intentos. Espera 15 minutos.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const ok = ADMIN_EMAIL && ADMIN_PASSWORD && safeEqual(email, ADMIN_EMAIL) && safeEqual(req.body.password || '', ADMIN_PASSWORD);
  if (!ok) {
    attempts.get(ip).push(Date.now());
    return res.status(401).render('admin/login', { error: 'Correo o contraseña incorrectos.' });
  }
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.admin = { email };
    res.redirect('/admin');
  });
});

r.post('/logout', (req, res) => {
  delete req.session.admin;
  res.redirect('/admin/login');
});

r.use((req, res, next) => (req.session.admin ? next() : res.redirect('/admin/login')));

const notice = (req, text, type = 'ok') => { req.session.notice = { text, type }; };
const PAID = `status IN ('paid','shipped','delivered')`;

/* ───────────── Dashboard ───────────── */
r.get('/', async (req, res) => {
  const days = [7, 30, 90].includes(lib.int(req.query.d)) ? lib.int(req.query.d) : 30;
  const cur = await one(
    `SELECT COALESCE(sum(total_cents),0)::int AS revenue, count(*)::int AS orders,
            COALESCE(sum((SELECT sum(qty) FROM order_items oi WHERE oi.order_id=o.id)),0)::int AS units
     FROM orders o WHERE ${PAID} AND created_at >= now() - ($1 || ' days')::interval`, [days]);
  const prev = await one(
    `SELECT COALESCE(sum(total_cents),0)::int AS revenue, count(*)::int AS orders FROM orders
     WHERE ${PAID} AND created_at >= now() - ($1 * 2 || ' days')::interval AND created_at < now() - ($1 || ' days')::interval`, [days]);
  const newCustomers = (await one(`SELECT count(*)::int AS n FROM customers WHERE created_at >= now() - ($1 || ' days')::interval`, [days])).n;
  const pending = (await one(`SELECT count(*)::int AS n FROM orders WHERE status IN ('pending','paid')`)).n;
  const series = await all(
    `SELECT d::date AS day, COALESCE(sum(o.total_cents),0)::int AS revenue, count(o.id)::int AS orders
     FROM generate_series((now() AT TIME ZONE 'America/Chicago')::date - ($1::int - 1), (now() AT TIME ZONE 'America/Chicago')::date, '1 day') d
     LEFT JOIN orders o ON (o.created_at AT TIME ZONE 'America/Chicago')::date = d::date AND o.${PAID}
     GROUP BY d ORDER BY d`, [days]);
  const top = await all(
    `SELECT oi.name, sum(oi.qty)::int AS units, sum(oi.qty * oi.unit_price_cents)::int AS revenue
     FROM order_items oi JOIN orders o ON o.id=oi.order_id
     WHERE o.${PAID} AND o.created_at >= now() - ($1 || ' days')::interval
     GROUP BY oi.name ORDER BY revenue DESC LIMIT 5`, [days]);
  const recent = await all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8');
  const lowStock = await all('SELECT id, name, stock FROM products WHERE active AND stock <= 20 ORDER BY stock ASC LIMIT 6');
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  res.render('admin/dashboard', {
    section: 'dash', days, cur, newCustomers, pending, series, top, recent, lowStock,
    aov: cur.orders ? Math.round(cur.revenue / cur.orders) : 0,
    delta: { revenue: pct(cur.revenue, prev.revenue), orders: pct(cur.orders, prev.orders) },
  });
});

/* ───────────── Products ───────────── */
r.get('/products', async (req, res) => {
  const products = await all(`SELECT p.*, COALESCE((SELECT sum(oi.qty) FROM order_items oi JOIN orders o ON o.id=oi.order_id
                                WHERE oi.product_id=p.id AND o.${PAID}),0)::int AS sold
                              FROM products p ORDER BY p.sort, p.id`);
  res.render('admin/products', { section: 'products', products });
});

r.get('/products/new', (req, res) =>
  res.render('admin/product_form', { section: 'products', p: { active: true, pack_size: 1, stock: 0, sort: 0 }, error: null }));

r.get('/products/:id', async (req, res, next) => {
  const p = await one('SELECT * FROM products WHERE id=$1', [lib.int(req.params.id)]);
  if (!p) return next();
  res.render('admin/product_form', { section: 'products', p, error: null });
});

function readProduct(body) {
  return {
    name: String(body.name || '').trim().slice(0, 150),
    name_es: String(body.name_es || '').trim().slice(0, 150),
    short_desc_es: String(body.short_desc_es || '').trim().slice(0, 200),
    description_es: String(body.description_es || '').trim().slice(0, 5000),
    slug: lib.slugify(body.slug || body.name || ''),
    short_desc: String(body.short_desc || '').trim().slice(0, 200),
    description: String(body.description || '').trim().slice(0, 5000),
    dimensions: String(body.dimensions || '').trim().slice(0, 60),
    pack_size: Math.max(1, lib.int(body.pack_size, 1)),
    price_cents: lib.toCents(body.price),
    compare_at_cents: lib.toCents(body.compare_at),
    stock: Math.max(0, lib.int(body.stock, 0)),
    sort: lib.int(body.sort, 0),
    active: body.active === 'on',
    featured: body.featured === 'on',
  };
}

async function saveImage(file) {
  if (!file) return null;
  const img = await one('INSERT INTO images(mime, data) VALUES($1,$2) RETURNING id', [file.mimetype, file.buffer]);
  return img.id;
}

r.post('/products', upload.single('image'), async (req, res) => {
  const p = readProduct(req.body);
  if (!p.name || p.price_cents == null) return res.status(400).render('admin/product_form', { section: 'products', p: { ...p, price_cents: p.price_cents ?? undefined }, error: 'Nombre y precio son obligatorios.' });
  const clash = await one('SELECT id FROM products WHERE slug=$1', [p.slug]);
  if (clash) p.slug = `${p.slug}-${Date.now().toString(36).slice(-4)}`;
  const imageId = await saveImage(req.file);
  const row = await one(
    `INSERT INTO products(name,slug,short_desc,description,dimensions,pack_size,price_cents,compare_at_cents,stock,sort,active,featured,image_id,name_es,short_desc_es,description_es)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [p.name, p.slug, p.short_desc, p.description, p.dimensions, p.pack_size, p.price_cents, p.compare_at_cents, p.stock, p.sort, p.active, p.featured, imageId, p.name_es, p.short_desc_es, p.description_es]);
  notice(req, 'Producto creado.');
  res.redirect(`/admin/products/${row.id}`);
});

r.post('/products/:id', upload.single('image'), async (req, res, next) => {
  const id = lib.int(req.params.id);
  const existing = await one('SELECT * FROM products WHERE id=$1', [id]);
  if (!existing) return next();
  const p = readProduct(req.body);
  if (!p.name || p.price_cents == null) return res.status(400).render('admin/product_form', { section: 'products', p: { ...existing, ...p, price_cents: p.price_cents ?? undefined }, error: 'Nombre y precio son obligatorios.' });
  const clash = await one('SELECT id FROM products WHERE slug=$1 AND id<>$2', [p.slug, id]);
  if (clash) p.slug = `${p.slug}-${id}`;
  let imageId = existing.image_id;
  if (req.file) imageId = await saveImage(req.file);
  if (req.body.remove_image === 'on') imageId = null;
  await q(
    `UPDATE products SET name=$1,slug=$2,short_desc=$3,description=$4,dimensions=$5,pack_size=$6,price_cents=$7,compare_at_cents=$8,
       stock=$9,sort=$10,active=$11,featured=$12,image_id=$13,name_es=$15,short_desc_es=$16,description_es=$17,updated_at=now() WHERE id=$14`,
    [p.name, p.slug, p.short_desc, p.description, p.dimensions, p.pack_size, p.price_cents, p.compare_at_cents, p.stock, p.sort, p.active, p.featured, imageId, id, p.name_es, p.short_desc_es, p.description_es]);
  if (existing.image_id && existing.image_id !== imageId) await q('DELETE FROM images WHERE id=$1', [existing.image_id]);
  notice(req, 'Cambios guardados.');
  res.redirect(`/admin/products/${id}`);
});

r.post('/products/:id/delete', async (req, res) => {
  const id = lib.int(req.params.id);
  const used = await one('SELECT 1 FROM order_items WHERE product_id=$1 LIMIT 1', [id]);
  if (used) {
    await q('UPDATE products SET active=false WHERE id=$1', [id]);
    notice(req, 'Este producto tiene pedidos, así que se ocultó de la tienda en lugar de borrarse.', 'warn');
  } else {
    const p = await one('DELETE FROM products WHERE id=$1 RETURNING image_id', [id]);
    if (p && p.image_id) await q('DELETE FROM images WHERE id=$1', [p.image_id]);
    notice(req, 'Producto eliminado.');
  }
  res.redirect('/admin/products');
});

/* ───────────── Orders ───────────── */
function orderFilter(query) {
  const where = [], params = [];
  if (query.status && lib.STATUS_ES[query.status]) { params.push(query.status); where.push(`status=$${params.length}`); }
  if (query.q) {
    params.push(`%${String(query.q).trim().toLowerCase()}%`);
    where.push(`(lower(number) LIKE $${params.length} OR lower(email) LIKE $${params.length} OR lower(name) LIKE $${params.length})`);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

r.get('/orders', async (req, res) => {
  const page = Math.max(1, lib.int(req.query.page, 1));
  const f = orderFilter(req.query);
  const total = (await one(`SELECT count(*)::int AS n FROM orders ${f.sql}`, f.params)).n;
  const list = await all(
    `SELECT o.*, (SELECT sum(qty) FROM order_items WHERE order_id=o.id)::int AS units FROM orders o ${f.sql}
     ORDER BY created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`, f.params);
  const counts = await all('SELECT status, count(*)::int AS n FROM orders GROUP BY status');
  res.render('admin/orders', {
    section: 'orders', list, total, page, pages: Math.max(1, Math.ceil(total / 50)),
    status: req.query.status || '', search: req.query.q || '',
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
});

r.get('/orders/export.csv', async (req, res) => {
  const f = orderFilter(req.query);
  const rows = await all(
    `SELECT o.*, (SELECT string_agg(qty || ' x ' || name, '; ') FROM order_items WHERE order_id=o.id) AS items
     FROM orders o ${f.sql} ORDER BY created_at DESC`, f.params);
  const cols = ['number', 'created_at', 'status', 'name', 'email', 'phone', 'fulfillment', 'address1', 'address2', 'city', 'state', 'zip', 'items', 'subtotal', 'discount', 'shipping', 'tax', 'total', 'coupon_code', 'payment_method', 'tracking'];
  const esc = (v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')].concat(rows.map((o) => cols.map((c) => {
    if (['subtotal', 'discount', 'shipping', 'tax', 'total'].includes(c)) return (o[`${c}_cents`] / 100).toFixed(2);
    return esc(o[c]);
  }).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="pedidos-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\n'));
});

r.get('/orders/:id', async (req, res, next) => {
  const order = await one('SELECT * FROM orders WHERE id=$1', [lib.int(req.params.id)]);
  if (!order) return next();
  const items = await all('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [order.id]);
  const history = await one(`SELECT count(*)::int AS n, COALESCE(sum(total_cents) FILTER (WHERE ${PAID}),0)::int AS spent FROM orders WHERE lower(email)=lower($1)`, [order.email]);
  res.render('admin/order', { section: 'orders', order, items, history });
});

r.post('/orders/:id', async (req, res, next) => {
  const id = lib.int(req.params.id);
  const order = await one('SELECT * FROM orders WHERE id=$1', [id]);
  if (!order) return next();
  const status = lib.STATUS_ES[req.body.status] ? req.body.status : order.status;
  const tracking = String(req.body.tracking ?? order.tracking).slice(0, 200);
  const notes = String(req.body.notes ?? order.notes).slice(0, 2000);

  if (order.status === 'cancelled' && status !== 'cancelled') {
    notice(req, 'Un pedido cancelado no se puede reactivar (su inventario ya se devolvió). Crea un pedido nuevo.', 'err');
    return res.redirect(`/admin/orders/${id}`);
  }
  if (status === 'cancelled' && order.status !== 'cancelled') await orders.cancelOrder(id);
  await q(
    `UPDATE orders SET status=$1, tracking=$2, notes=$3, updated_at=now(),
       paid_at = CASE WHEN $1 IN ('paid','shipped','delivered') AND paid_at IS NULL THEN now() ELSE paid_at END
     WHERE id=$4`, [status, tracking, notes, id]);
  notice(req, status === 'cancelled' && order.status !== 'cancelled' ? 'Pedido cancelado y stock devuelto al inventario.' : 'Pedido actualizado.');
  res.redirect(`/admin/orders/${id}`);
});

/* ───────────── Customers ───────────── */
r.get('/customers', async (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  const params = [];
  let where = '';
  if (search) { params.push(`%${search}%`); where = 'WHERE lower(c.email) LIKE $1 OR lower(c.name) LIKE $1 OR c.phone LIKE $1'; }
  const list = await all(
    `SELECT c.*, count(o.id)::int AS orders,
            COALESCE(sum(o.total_cents) FILTER (WHERE o.${PAID}),0)::int AS spent,
            max(o.created_at) AS last_order
     FROM customers c LEFT JOIN orders o ON o.customer_id=c.id ${where}
     GROUP BY c.id ORDER BY last_order DESC NULLS LAST LIMIT 200`, params);
  res.render('admin/customers', { section: 'customers', list, search });
});

r.get('/customers.csv', async (req, res) => {
  const list = await all(`SELECT c.name, c.email, c.phone, c.created_at, count(o.id)::int AS orders,
      COALESCE(sum(o.total_cents) FILTER (WHERE o.${PAID}),0)::int AS spent
    FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`);
  const esc = (s) => { s = String(s ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = ['name,email,phone,since,orders,spent'].concat(list.map((c) =>
    [esc(c.name), esc(c.email), esc(c.phone), c.created_at.toISOString().slice(0, 10), c.orders, (c.spent / 100).toFixed(2)].join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="clientes.csv"').send('﻿' + out.join('\n'));
});

/* ───────────── Coupons ───────────── */
r.get('/coupons', async (req, res) => {
  const list = await all('SELECT * FROM coupons ORDER BY created_at DESC');
  res.render('admin/coupons', { section: 'coupons', list, error: null, form: {} });
});

r.post('/coupons', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
  const type = req.body.type === 'fixed' ? 'fixed' : 'percent';
  const value = type === 'percent' ? lib.int(req.body.value) : lib.toCents(req.body.value);
  const min = lib.toCents(req.body.min_subtotal) || 0;
  const maxUses = req.body.max_uses ? Math.max(1, lib.int(req.body.max_uses)) : null;
  const expires = req.body.expires_at ? new Date(`${req.body.expires_at}T23:59:59-06:00`) : null;
  let error = null;
  if (!code) error = 'Escribe un código.';
  else if (!value || value <= 0 || (type === 'percent' && value > 100)) error = 'El valor del descuento no es válido.';
  else if (expires && isNaN(expires)) error = 'Fecha no válida.';
  else if (await one('SELECT 1 FROM coupons WHERE upper(code)=$1', [code])) error = 'Ya existe un cupón con ese código.';
  if (error) {
    const list = await all('SELECT * FROM coupons ORDER BY created_at DESC');
    return res.status(400).render('admin/coupons', { section: 'coupons', list, error, form: req.body });
  }
  await q('INSERT INTO coupons(code,type,value,min_subtotal_cents,max_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [code, type, value, min, maxUses, expires]);
  notice(req, `Cupón ${code} creado.`);
  res.redirect('/admin/coupons');
});

r.post('/coupons/:id/toggle', async (req, res) => {
  await q('UPDATE coupons SET active = NOT active WHERE id=$1', [lib.int(req.params.id)]);
  res.redirect('/admin/coupons');
});

r.post('/coupons/:id/delete', async (req, res) => {
  await q('DELETE FROM coupons WHERE id=$1', [lib.int(req.params.id)]);
  notice(req, 'Cupón eliminado.');
  res.redirect('/admin/coupons');
});

/* ───────────── Settings ───────────── */
const SETTING_FIELDS = ['store_name', 'support_email', 'support_phone', 'pickup_address', 'announcement_en', 'announcement_es'];
r.get('/settings', (req, res) => res.render('admin/settings', { section: 'settings' }));
r.post('/settings', upload.single('hero'), async (req, res) => {
  const values = {};
  const oldHero = res.locals.settings.hero_image_id;
  if (req.file) values.hero_image_id = String(await saveImage(req.file));
  else if (req.body.remove_hero === 'on') values.hero_image_id = '';
  for (const k of SETTING_FIELDS) values[k] = String(req.body[k] || '').trim().slice(0, 300);
  values.shipping_flat_cents = String(lib.toCents(req.body.shipping_flat) ?? 0);
  values.free_shipping_min_cents = String(lib.toCents(req.body.free_shipping_min) ?? 0);
  const tax = Number(String(req.body.tax_rate_percent || '0').replace(',', '.'));
  values.tax_rate_percent = String(Number.isFinite(tax) && tax >= 0 && tax < 50 ? tax : 0);
  values.pickup_enabled = req.body.pickup_enabled === 'on' ? 'true' : 'false';
  await tx(async (c) => {
    for (const [k, v] of Object.entries(values)) {
      await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
    }
  });
  if (oldHero && values.hero_image_id !== undefined && values.hero_image_id !== oldHero) await q('DELETE FROM images WHERE id=$1', [lib.int(oldHero)]);
  notice(req, 'Configuración guardada.');
  res.redirect('/admin/settings');
});

module.exports = r;

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { q, one, all, tx, clearSettingsCache } = require('../db');
const lib = require('../lib');
const auth = require('../auth');
const orders = require('../orders');
const reports = require('../reports');
const notify = require('../notify');
const { limiter } = require('../ratelimit');

const r = express.Router();

const MAX_MB = 5;
// Rejecting (instead of silently skipping) unsupported files, e.g. iPhone HEIC,
// so the admin sees why the photo didn't change.
const imageFilter = (req, file, cb) => (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)
  ? cb(null, true)
  : cb(Object.assign(new Error('Unsupported image type'), { code: 'BAD_IMAGE_TYPE' })));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 }, fileFilter: imageFilter });
const uploadProduct = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 9 }, fileFilter: imageFilter })
  .fields([{ name: 'image', maxCount: 1 }, { name: 'gallery', maxCount: 8 }]);

// Turns upload errors into a friendly notice instead of a generic 500 page.
function handleUpload(mw, backUrl) {
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (!(err instanceof multer.MulterError) && err.code !== 'BAD_IMAGE_TYPE') return next(err);
    const text = err.code === 'LIMIT_FILE_SIZE' ? `Una imagen pesa más de ${MAX_MB} MB. Redúcela e intenta de nuevo.`
      : err.code === 'BAD_IMAGE_TYPE' ? 'Formato de imagen no soportado. Usa JPG, PNG o WebP (las fotos HEIC del iPhone hay que convertirlas).'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Demasiadas imágenes a la vez (máximo 8 en la galería).'
      : 'No se pudo subir la imagen.';
    req.session.notice = { text, type: 'err' };
    res.redirect(backUrl(req));
  });
}

const loginLimit = limiter({ max: 8, windowMs: 15 * 60 * 1000 });

r.use((req, res, next) => {
  res.locals.STATUS = lib.STATUS_ES;
  res.locals.PAYMENT = lib.PAYMENT_ES;
  res.locals.fmtDate = (d, time = true) => d ? new Date(d).toLocaleString('es-US', { timeZone: 'America/Chicago', dateStyle: 'medium', ...(time ? { timeStyle: 'short' } : {}) }) : '—';
  res.locals.notice = req.session.notice || null;
  delete req.session.notice;
  res.set('Cache-Control', 'no-store');
  next();
});

r.get('/login', (req, res) => res.render('admin/login', { error: null }));

r.post('/login', async (req, res, next) => {
  if (loginLimit.blocked(req.ip)) return res.status(429).render('admin/login', { error: 'Demasiados intentos. Espera 15 minutos.' });
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const admin = email ? await one('SELECT * FROM admin_users WHERE email=$1', [email]) : null;
  const ok = await auth.verifyPassword(req.body.password || '', admin && admin.password_hash);
  if (!ok) {
    loginLimit.hit(req.ip);
    return res.status(401).render('admin/login', { error: 'Correo o contraseña incorrectos.' });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.admin = { id: admin.id };
    res.redirect('/admin');
  });
});

r.post('/logout', (req, res) => {
  delete req.session.admin;
  res.redirect('/admin/login');
});

// Re-read the admin on every request so removing an admin (or changing their
// permissions) takes effect immediately instead of when their cookie expires.
r.use(async (req, res, next) => {
  const id = req.session.admin && lib.int(req.session.admin.id, 0);
  const a = id ? await one('SELECT id, email, role, perm_orders, perm_products FROM admin_users WHERE id=$1', [id]) : null;
  if (!a) {
    delete req.session.admin;
    return res.redirect('/admin/login');
  }
  res.locals.admin = a;
  res.locals.can = {
    orders: a.role === 'owner' || a.perm_orders,
    products: a.role === 'owner' || a.perm_products,
    // Site text/images/shipping/payment settings and managing other admins
    // stay owner-only; there is no partial grant for either.
    settings: a.role === 'owner',
    users: a.role === 'owner',
  };
  res.locals.unreadMessages = res.locals.can.orders ? (await one("SELECT count(*)::int AS n FROM contact_messages WHERE NOT read")).n : 0;
  next();
});

function requirePerm(key) {
  return (req, res, next) => {
    if (res.locals.can[key]) return next();
    res.status(403).send('No tienes permiso para ver esta sección. Pídele acceso a un administrador.');
  };
}

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
  const to = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const fromD = new Date(`${to}T12:00:00Z`);
  fromD.setUTCDate(fromD.getUTCDate() - (days - 1));
  res.render('admin/dashboard', {
    section: 'dash', days, cur, newCustomers, pending, series, top, recent, lowStock,
    range: { from: fromD.toISOString().slice(0, 10), to },
    aov: cur.orders ? Math.round(cur.revenue / cur.orders) : 0,
    delta: { revenue: pct(cur.revenue, prev.revenue), orders: pct(cur.orders, prev.orders) },
  });
});

/* ───────────── Sales reports (same audience as the dashboard) ───────────── */
r.get('/reports/sales.xlsx', (req, res) => reports.salesXlsx(res, reports.parseRange(req.query)));
r.get('/reports/sales.pdf', (req, res) => reports.salesPdf(res, reports.parseRange(req.query)));

/* ───────────── Products ───────────── */
r.use('/products', requirePerm('products'));
r.get('/products', async (req, res) => {
  const products = await all(`SELECT p.*, COALESCE((SELECT sum(oi.qty) FROM order_items oi JOIN orders o ON o.id=oi.order_id
                                WHERE oi.product_id=p.id AND o.${PAID}),0)::int AS sold
                              FROM products p ORDER BY p.sort, p.id`);
  res.render('admin/products', { section: 'products', products });
});

r.get('/products/inventory.xlsx', (req, res) => reports.inventoryXlsx(res));
r.get('/products/inventory.pdf', (req, res) => reports.inventoryPdf(res));

// Creating a product, changing its name/description/photos, or deleting it
// requires the owner-only "settings" permission; "Productos y cupones" staff
// can only adjust price/stock/visibility on existing products.
r.get('/products/new', requirePerm('settings'), (req, res) =>
  res.render('admin/product_form', { section: 'products', p: { active: true, pack_size: 1, stock: 0, sort: 0 }, gallery: [], error: null }));

r.get('/products/:id', async (req, res, next) => {
  const p = await one('SELECT * FROM products WHERE id=$1', [lib.int(req.params.id)]);
  if (!p) return next();
  const gallery = await all('SELECT id, image_id FROM product_images WHERE product_id=$1 ORDER BY sort, id', [p.id]);
  res.render('admin/product_form', { section: 'products', p, gallery, error: null });
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

// Resize + re-encode as WebP so a phone photo (often 3-8 MB) doesn't ship
// to visitors at full size. Falls back to the original file if sharp can't
// read it (corrupt upload, unusual format) rather than losing the upload.
async function saveImage(file, { maxWidth = 1600 } = {}) {
  if (!file) return null;
  let mime = file.mimetype, data = file.buffer;
  if (mime !== 'image/gif') {
    try {
      data = await sharp(file.buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      mime = 'image/webp';
    } catch (e) {
      console.error('Image optimize error:', e.message);
    }
  }
  const img = await one('INSERT INTO images(mime, data) VALUES($1,$2) RETURNING id', [mime, data]);
  return img.id;
}

async function saveGallery(productId, files) {
  if (!files || !files.length) return;
  const start = (await one('SELECT COALESCE(MAX(sort), -1) AS n FROM product_images WHERE product_id=$1', [productId])).n + 1;
  for (let i = 0; i < files.length; i++) {
    const imageId = await saveImage(files[i]);
    await q('INSERT INTO product_images(product_id, image_id, sort) VALUES($1,$2,$3)', [productId, imageId, start + i]);
  }
}

r.post('/products', requirePerm('settings'), handleUpload(uploadProduct, () => '/admin/products/new'), async (req, res) => {
  const p = readProduct(req.body);
  if (!p.name || p.price_cents == null) return res.status(400).render('admin/product_form', { section: 'products', p: { ...p, price_cents: p.price_cents ?? undefined }, gallery: [], error: 'Nombre y precio son obligatorios.' });
  const clash = await one('SELECT id FROM products WHERE slug=$1', [p.slug]);
  if (clash) p.slug = `${p.slug}-${Date.now().toString(36).slice(-4)}`;
  const imageId = await saveImage(req.files?.image?.[0]);
  const row = await one(
    `INSERT INTO products(name,slug,short_desc,description,dimensions,pack_size,price_cents,compare_at_cents,stock,sort,active,featured,image_id,name_es,short_desc_es,description_es)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [p.name, p.slug, p.short_desc, p.description, p.dimensions, p.pack_size, p.price_cents, p.compare_at_cents, p.stock, p.sort, p.active, p.featured, imageId, p.name_es, p.short_desc_es, p.description_es]);
  await saveGallery(row.id, req.files?.gallery);
  notice(req, 'Producto creado.');
  res.redirect(`/admin/products/${row.id}`);
});

r.post('/products/:id', handleUpload(uploadProduct, (req) => `/admin/products/${lib.int(req.params.id)}`), async (req, res, next) => {
  const id = lib.int(req.params.id);
  const existing = await one('SELECT * FROM products WHERE id=$1', [id]);
  if (!existing) return next();
  const fullEdit = res.locals.can.settings;
  // Price/stock-only staff: whatever they submit for name/text/photos is
  // ignored server-side and the existing values are kept, rather than
  // trusting a hidden field or a disabled input's last value.
  const p = fullEdit ? readProduct(req.body) : {
    ...readProduct(req.body),
    name: existing.name, name_es: existing.name_es, short_desc: existing.short_desc, short_desc_es: existing.short_desc_es,
    description: existing.description, description_es: existing.description_es, dimensions: existing.dimensions, slug: existing.slug,
  };
  if (!p.name || p.price_cents == null) {
    const gallery = await all('SELECT id, image_id FROM product_images WHERE product_id=$1 ORDER BY sort, id', [id]);
    return res.status(400).render('admin/product_form', { section: 'products', p: { ...existing, ...p, price_cents: p.price_cents ?? undefined }, gallery, error: 'Nombre y precio son obligatorios.' });
  }
  if (fullEdit) {
    const clash = await one('SELECT id FROM products WHERE slug=$1 AND id<>$2', [p.slug, id]);
    if (clash) p.slug = `${p.slug}-${id}`;
  }
  let imageId = existing.image_id;
  if (fullEdit) {
    if (req.files?.image?.[0]) imageId = await saveImage(req.files.image[0]);
    if (req.body.remove_image === 'on') imageId = null;
  }
  await q(
    `UPDATE products SET name=$1,slug=$2,short_desc=$3,description=$4,dimensions=$5,pack_size=$6,price_cents=$7,compare_at_cents=$8,
       stock=$9,sort=$10,active=$11,featured=$12,image_id=$13,name_es=$15,short_desc_es=$16,description_es=$17,updated_at=now() WHERE id=$14`,
    [p.name, p.slug, p.short_desc, p.description, p.dimensions, p.pack_size, p.price_cents, p.compare_at_cents, p.stock, p.sort, p.active, p.featured, imageId, id, p.name_es, p.short_desc_es, p.description_es]);
  if (fullEdit) {
    if (existing.image_id && existing.image_id !== imageId) await q('DELETE FROM images WHERE id=$1', [existing.image_id]);
    const removeIds = [].concat(req.body.remove_gallery || []).map(Number).filter(Boolean);
    if (removeIds.length) {
      await q('DELETE FROM images WHERE id IN (SELECT image_id FROM product_images WHERE product_id=$1 AND id = ANY($2::int[]))', [id, removeIds]);
      await q('DELETE FROM product_images WHERE product_id=$1 AND id = ANY($2::int[])', [id, removeIds]);
    }
    await saveGallery(id, req.files?.gallery);
  }
  notice(req, 'Cambios guardados.');
  res.redirect(`/admin/products/${id}`);
});

r.post('/products/:id/gallery/:rowId/cover', requirePerm('settings'), async (req, res, next) => {
  const id = lib.int(req.params.id);
  const rowId = lib.int(req.params.rowId);
  const product = await one('SELECT id, image_id FROM products WHERE id=$1', [id]);
  if (!product) return next();
  const row = await one('SELECT * FROM product_images WHERE id=$1 AND product_id=$2', [rowId, id]);
  if (!row) return next();
  await tx(async (c) => {
    await c.query('UPDATE products SET image_id=$1, updated_at=now() WHERE id=$2', [row.image_id, id]);
    if (product.image_id) await c.query('UPDATE product_images SET image_id=$1 WHERE id=$2', [product.image_id, rowId]);
    else await c.query('DELETE FROM product_images WHERE id=$1', [rowId]);
  });
  notice(req, 'Foto de portada actualizada.');
  res.redirect(`/admin/products/${id}`);
});

r.post('/products/:id/delete', requirePerm('settings'), async (req, res) => {
  const id = lib.int(req.params.id);
  const used = await one('SELECT 1 FROM order_items WHERE product_id=$1 LIMIT 1', [id]);
  if (used) {
    await q('UPDATE products SET active=false WHERE id=$1', [id]);
    notice(req, 'Este producto tiene pedidos, así que se ocultó de la tienda en lugar de borrarse.', 'warn');
  } else {
    const galleryImageIds = (await all('SELECT image_id FROM product_images WHERE product_id=$1', [id])).map((r) => r.image_id);
    const p = await one('DELETE FROM products WHERE id=$1 RETURNING image_id', [id]);
    const ids = [...galleryImageIds, ...(p && p.image_id ? [p.image_id] : [])];
    if (ids.length) await q('DELETE FROM images WHERE id = ANY($1::int[])', [ids]);
    notice(req, 'Producto eliminado.');
  }
  res.redirect('/admin/products');
});

/* ───────────── Orders ───────────── */
r.use('/orders', requirePerm('orders'));
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

r.get('/orders/export.xlsx', (req, res) => reports.ordersXlsx(res, orderFilter(req.query)));

r.get('/orders/customer-search', async (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  if (search.length < 2) return res.json([]);
  const rows = await all(
    `SELECT id, name, email, phone, address1, address2, city, state, zip
     FROM customers WHERE lower(email) LIKE $1 OR lower(name) LIKE $1 OR phone LIKE $1
     ORDER BY name LIMIT 8`, [`%${search}%`]);
  res.json(rows);
});

/* Orders entered by staff (phone, walk-in, WhatsApp...) */
const manualForm = async (res, form, error, status = 200) => {
  const products = await all('SELECT id, name, dimensions, price_cents, stock, active FROM products ORDER BY active DESC, sort, id');
  res.status(status).render('admin/order_new', { section: 'orders', products, form, error, PAYMENTS: lib.MANUAL_PAYMENTS.map((k) => [k, lib.PAYMENT_ES[k]]) });
};

r.get('/orders/new', (req, res) => manualForm(res, { status: 'paid', payment_method: 'cash', fulfillment: 'pickup', qty: {}, price: {}, lang: 'es', send_email: true }, null));

r.post('/orders/new', async (req, res) => {
  const b = req.body;
  const str = (k, n = 200) => String(b[k] || '').trim().slice(0, n);
  const form = {
    name: str('name'), email: str('email').toLowerCase(), phone: str('phone', 60), fulfillment: b.fulfillment === 'delivery' ? 'delivery' : 'pickup',
    address1: str('address1'), address2: str('address2'), city: str('city'), state: str('state').toUpperCase(), zip: str('zip', 10), notes: str('notes', 2000),
    status: lib.STATUS_ES[b.status] && b.status !== 'cancelled' ? b.status : 'pending',
    payment_method: lib.MANUAL_PAYMENTS.includes(b.payment_method) ? b.payment_method : 'other',
    shipping: b.shipping || '', discount: b.discount || '', tax: b.tax || '', allow_oversell: b.allow_oversell === 'on', qty: {}, price: {},
    lang: b.lang === 'en' ? 'en' : 'es', send_email: b.send_email === 'on',
  };
  const lines = [];
  for (const [k, v] of Object.entries(b)) {
    const m = /^qty_(\d+)$/.exec(k);
    if (!m) continue;
    const qty = Math.max(0, Math.min(lib.int(v), 100000));
    form.qty[m[1]] = v;
    form.price[m[1]] = b[`price_${m[1]}`] || '';
    if (!qty) continue;
    const price = lib.toCents(b[`price_${m[1]}`]);
    if (price == null) return manualForm(res, form, 'Revisa el precio de los productos que agregaste.', 400);
    lines.push({ product_id: lib.int(m[1]), qty, unit_price_cents: price });
  }
  const amounts = { shipping: lib.toCents(form.shipping) || 0, discount: lib.toCents(form.discount) || 0, tax: lib.toCents(form.tax) || 0 };
  let error = null;
  if (!form.name) error = 'Escribe el nombre del cliente.';
  else if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) error = 'El correo no es válido (puedes dejarlo vacío).';
  else if (!lines.length) error = 'Agrega al menos un producto con cantidad.';
  else if (form.fulfillment === 'delivery' && (!form.address1 || !form.city || !lib.US_STATES.includes(form.state) || !/^\d{5}(-\d{4})?$/.test(form.zip))) {
    error = 'Para envío, completa dirección, ciudad, estado y código postal (5 dígitos).';
  }
  if (error) return manualForm(res, form, error, 400);
  if (form.fulfillment === 'pickup') form.address1 = form.address2 = form.city = form.state = form.zip = '';
  try {
    const order = await orders.createManualOrder({
      lines, form, amounts, paymentMethod: form.payment_method, status: form.status,
      adminEmail: res.locals.admin.email, allowOversell: form.allow_oversell,
    });
    if (form.send_email && order.email) notify.orderStatus(order, res.locals.siteUrl);
    notice(req, `Pedido ${order.number} registrado.${form.send_email && order.email ? ' Se envió la confirmación al cliente.' : ''}`);
    res.redirect(`/admin/orders/${order.id}`);
  } catch (e) {
    if (e instanceof orders.StockError) return manualForm(res, form, `No hay suficiente stock de: ${e.message}. Ajusta la cantidad o marca "vender aunque no haya stock".`, 400);
    throw e;
  }
});

r.get('/orders/:id', async (req, res, next) => {
  const order = await one('SELECT * FROM orders WHERE id=$1', [lib.int(req.params.id)]);
  if (!order) return next();
  const items = await all('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [order.id]);
  const history = await one(`SELECT count(*)::int AS n, COALESCE(sum(total_cents) FILTER (WHERE ${PAID}),0)::int AS spent FROM orders WHERE lower(email)=lower($1)`, [order.email]);
  res.render('admin/order', { section: 'orders', order, items, history });
});

r.get('/orders/:id/packing-slip.pdf', async (req, res, next) => {
  const order = await one('SELECT * FROM orders WHERE id=$1', [lib.int(req.params.id)]);
  if (!order) return next();
  const items = await all('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [order.id]);
  reports.packingSlipPdf(res, order, items, res.locals.settings);
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
       paid_at = CASE WHEN $1 IN ('paid','shipped','delivered') AND paid_at IS NULL THEN now() ELSE paid_at END,
       shipped_at = CASE WHEN $1 IN ('shipped','delivered') AND shipped_at IS NULL THEN now() ELSE shipped_at END,
       delivered_at = CASE WHEN $1 = 'delivered' AND delivered_at IS NULL THEN now() ELSE delivered_at END
     WHERE id=$4`, [status, tracking, notes, id]);
  if (status !== order.status && req.body.notify_customer === 'on') {
    notify.orderStatus(await one('SELECT * FROM orders WHERE id=$1', [id]), res.locals.siteUrl);
  }
  notice(req, status === 'cancelled' && order.status !== 'cancelled' ? 'Pedido cancelado y stock devuelto al inventario.' : 'Pedido actualizado.');
  res.redirect(`/admin/orders/${id}`);
});

/* ───────────── Customers ───────────── */
r.use(['/customers', '/customers.csv'], requirePerm('orders'));
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

/* ───────────── Contact messages ───────────── */
r.use('/messages', requirePerm('orders'));
r.get('/messages', async (req, res) => {
  const list = await all('SELECT * FROM contact_messages ORDER BY created_at DESC');
  res.render('admin/messages', { section: 'messages', list });
});

r.post('/messages/:id/read', async (req, res) => {
  await q('UPDATE contact_messages SET read = NOT read WHERE id=$1', [lib.int(req.params.id)]);
  res.redirect('/admin/messages');
});

r.post('/messages/:id/delete', async (req, res) => {
  await q('DELETE FROM contact_messages WHERE id=$1', [lib.int(req.params.id)]);
  notice(req, 'Mensaje eliminado.');
  res.redirect('/admin/messages');
});

/* ───────────── Coupons ───────────── */
r.use('/coupons', requirePerm('products'));
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
  await q('INSERT INTO coupons(code,type,value,min_subtotal_cents,max_uses,expires_at,once_per_customer) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [code, type, value, min, maxUses, expires, req.body.once_per_customer === 'on']);
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
r.use('/settings', requirePerm('settings'));
const SETTING_FIELDS = ['store_name', 'support_email', 'support_phone', 'pickup_address', 'announcement_en', 'announcement_es', 'notify_email'];
r.get('/settings', (req, res) => res.render('admin/settings', { section: 'settings' }));
r.post('/settings', handleUpload(upload.single('hero'), () => '/admin/settings'), async (req, res) => {
  const values = {};
  const oldHero = res.locals.settings.hero_image_id;
  if (req.file) values.hero_image_id = String(await saveImage(req.file, { maxWidth: 2000 }));
  else if (req.body.remove_hero === 'on') values.hero_image_id = '';
  for (const k of SETTING_FIELDS) values[k] = String(req.body[k] || '').trim().slice(0, 300);
  values.shipping_flat_cents = String(lib.toCents(req.body.shipping_flat) ?? 0);
  values.free_shipping_min_cents = String(lib.toCents(req.body.free_shipping_min) ?? 0);
  const tax = Number(String(req.body.tax_rate_percent || '0').replace(',', '.'));
  values.tax_rate_percent = String(Number.isFinite(tax) && tax >= 0 && tax < 50 ? tax : 0);
  values.pickup_enabled = req.body.pickup_enabled === 'on' ? 'true' : 'false';
  values.reminder_payment_enabled = req.body.reminder_payment_enabled === 'on' ? 'true' : 'false';
  values.digest_enabled = req.body.digest_enabled === 'on' ? 'true' : 'false';
  values.lowstock_alert_enabled = req.body.lowstock_alert_enabled === 'on' ? 'true' : 'false';
  values.cart_reminder_enabled = req.body.cart_reminder_enabled === 'on' ? 'true' : 'false';
  values.payment_instructions = String(req.body.payment_instructions || '').trim().slice(0, 1000);
  // wa.me needs digits with country code; a 10-digit number is assumed to be US.
  let wa = String(req.body.whatsapp_number || '').replace(/\D/g, '').slice(0, 15);
  if (wa.length === 10) wa = `1${wa}`;
  values.whatsapp_number = wa;
  await tx(async (c) => {
    for (const [k, v] of Object.entries(values)) {
      await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
    }
  });
  if (oldHero && values.hero_image_id !== undefined && values.hero_image_id !== oldHero) await q('DELETE FROM images WHERE id=$1', [lib.int(oldHero)]);
  clearSettingsCache();
  notice(req, 'Configuración guardada.');
  res.redirect('/admin/settings');
});

/* ───────────── My password (any admin) ───────────── */
r.get('/password', (req, res) => res.render('admin/password', { section: 'password', error: null }));

r.post('/password', async (req, res) => {
  const row = await one('SELECT password_hash FROM admin_users WHERE id=$1', [res.locals.admin.id]);
  const next = String(req.body.new_password || '');
  let error = null;
  if (!(await auth.verifyPassword(req.body.current_password || '', row.password_hash))) error = 'La contraseña actual no es correcta.';
  else if (next.length < 8) error = 'La nueva contraseña debe tener al menos 8 caracteres.';
  else if (next !== String(req.body.confirm_password || '')) error = 'Las contraseñas nuevas no coinciden.';
  if (error) return res.status(400).render('admin/password', { section: 'password', error });
  await q('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [await auth.hashPassword(next), res.locals.admin.id]);
  notice(req, 'Contraseña actualizada.');
  res.redirect('/admin/password');
});

/* ───────────── Admin users ───────────── */
r.use('/users', requirePerm('users'));

r.get('/users', async (req, res) => {
  const list = await all('SELECT id, email, role, perm_orders, perm_products, created_at FROM admin_users ORDER BY created_at');
  res.render('admin/users', { section: 'users', list, error: null });
});

r.post('/users', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body.password || '');
  const role = req.body.role === 'owner' ? 'owner' : 'staff';
  const permOrders = role === 'owner' || req.body.perm_orders === 'on';
  const permProducts = role === 'owner' || req.body.perm_products === 'on';
  let error = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = 'Ingresa un correo válido.';
  else if (password.length < 8) error = 'La contraseña debe tener al menos 8 caracteres.';
  else if (role === 'staff' && !permOrders && !permProducts) error = 'Elige al menos un permiso (Pedidos o Productos).';
  else if (await one('SELECT 1 FROM admin_users WHERE email=$1', [email])) error = 'Ya existe un admin con ese correo.';
  if (error) {
    const list = await all('SELECT id, email, role, perm_orders, perm_products, created_at FROM admin_users ORDER BY created_at');
    return res.status(400).render('admin/users', { section: 'users', list, error });
  }
  await q('INSERT INTO admin_users(email, password_hash, role, perm_orders, perm_products) VALUES($1,$2,$3,$4,$5)',
    [email, await auth.hashPassword(password), role, permOrders, permProducts]);
  notice(req, `Admin ${email} creado.`);
  res.redirect('/admin/users');
});

r.post('/users/:id/delete', async (req, res) => {
  const id = lib.int(req.params.id);
  if (id === res.locals.admin.id) {
    notice(req, 'No puedes eliminar tu propia cuenta mientras tienes sesión iniciada.', 'err');
    return res.redirect('/admin/users');
  }
  const total = (await one('SELECT count(*)::int AS n FROM admin_users')).n;
  if (total <= 1) {
    notice(req, 'Debe quedar al menos un admin.', 'err');
    return res.redirect('/admin/users');
  }
  await q('DELETE FROM admin_users WHERE id=$1', [id]);
  notice(req, 'Admin eliminado.');
  res.redirect('/admin/users');
});

module.exports = r;

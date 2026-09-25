const { tx, one } = require('./db');
const lib = require('./lib');
const notify = require('./notify');

class StockError extends Error {}
class CouponUsedError extends Error {}

// Guest/admin-entered orders may only refresh the profile of a guest record;
// anyone can type any email, so a registered account's name/phone is never overwritten.
async function upsertGuestCustomer(c, form) {
  const { rows: [cust] } = await c.query(
    `INSERT INTO customers(email,name,phone) VALUES(lower($1),$2,$3)
     ON CONFLICT (email) DO UPDATE SET
       name  = CASE WHEN customers.password_hash IS NULL THEN EXCLUDED.name ELSE customers.name END,
       phone = CASE WHEN customers.password_hash IS NULL THEN COALESCE(NULLIF(EXCLUDED.phone,''), customers.phone) ELSE customers.phone END
     RETURNING id`, [form.email, form.name, form.phone]);
  return cust;
}

/**
 * Order entered by staff (phone, walk-in, WhatsApp...). Prices can differ from
 * the catalog; stock is reserved like a web order unless allowOversell is set.
 */
async function createManualOrder({ lines, form, amounts, paymentMethod, status, adminEmail, allowOversell }) {
  const crossed = [];
  const order = await tx(async (c) => {
    const ids = lines.map((l) => l.product_id);
    const { rows: locked } = await c.query('SELECT id, name, stock FROM products WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    const byId = Object.fromEntries(locked.map((r) => [r.id, r]));
    for (const l of lines) {
      const p = byId[l.product_id];
      if (!p) throw new StockError('?');
      if (!allowOversell && p.stock < l.qty) throw new StockError(`${p.name} (hay ${p.stock})`);
    }
    for (const l of lines) {
      const p = byId[l.product_id];
      const after = Math.max(p.stock - l.qty, 0);
      if (p.stock > lib.LOW_STOCK_THRESHOLD && after <= lib.LOW_STOCK_THRESHOLD) crossed.push({ name: p.name, stock: after });
      await c.query('UPDATE products SET stock = GREATEST(stock - $1, 0), updated_at = now() WHERE id=$2', [l.qty, l.product_id]);
    }
    const cust = form.email ? await upsertGuestCustomer(c, form) : null;
    const subtotal = lines.reduce((s, l) => s + l.unit_price_cents * l.qty, 0);
    const discount = Math.min(amounts.discount, subtotal);
    const total = subtotal - discount + amounts.shipping + amounts.tax;
    const paid = ['paid', 'shipped', 'delivered'].includes(status);
    const { rows: [order] } = await c.query(
      `INSERT INTO orders(number, access_token, customer_id, email, name, phone, fulfillment, address1, address2, city, state, zip,
         subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents, status, payment_method, notes, source, created_by, lang,
         paid_at, shipped_at, delivered_at)
       VALUES($1,$2,$3,lower($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'admin',$21,$22,
         ${paid ? 'now()' : 'NULL'}, ${['shipped', 'delivered'].includes(status) ? 'now()' : 'NULL'}, ${status === 'delivered' ? 'now()' : 'NULL'}) RETURNING *`,
      [lib.orderNumber(), lib.token(), cust ? cust.id : null, form.email, form.name, form.phone, form.fulfillment,
       form.address1, form.address2, form.city, form.state, form.zip,
       subtotal, discount, amounts.shipping, amounts.tax, total, status, paymentMethod, form.notes, adminEmail, form.lang === 'en' ? 'en' : 'es']);
    for (const l of lines) {
      await c.query('INSERT INTO order_items(order_id, product_id, name, unit_price_cents, qty) VALUES($1,$2,$3,$4,$5)',
        [order.id, l.product_id, byId[l.product_id].name, l.unit_price_cents, l.qty]);
    }
    return order;
  });
  notify.lowStockAlert(crossed);
  return order;
}

/**
 * Creates an order atomically: locks product rows, re-checks stock, reserves it,
 * counts the coupon use and upserts the customer.
 */
async function createOrder({ priced, form, paymentMethod, customerId = null }) {
  const crossed = [];
  const order = await tx(async (c) => {
    const ids = priced.lines.map((l) => l.product.id);
    const { rows: locked } = await c.query('SELECT id, stock, active FROM products WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    const byId = Object.fromEntries(locked.map((r) => [r.id, r]));
    for (const l of priced.lines) {
      const p = byId[l.product.id];
      if (!p || !p.active || p.stock < l.qty) throw new StockError();
    }
    for (const l of priced.lines) {
      const p = byId[l.product.id];
      const after = Math.max(p.stock - l.qty, 0);
      if (p.stock > lib.LOW_STOCK_THRESHOLD && after <= lib.LOW_STOCK_THRESHOLD) crossed.push({ name: l.product.name, stock: after });
      await c.query('UPDATE products SET stock = stock - $1, updated_at = now() WHERE id=$2', [l.qty, l.product.id]);
    }
    if (priced.coupon) {
      const { rowCount } = await c.query(
        'UPDATE coupons SET uses = uses + 1 WHERE id=$1 AND (max_uses IS NULL OR uses < max_uses)', [priced.coupon.id]);
      if (!rowCount) throw new StockError(); // coupon ran out in a race
    }
    const cust = customerId ? { id: customerId } : await upsertGuestCustomer(c, form);

    if (priced.coupon && priced.coupon.once_per_customer) {
      const { rowCount } = await c.query(
        `SELECT 1 FROM orders WHERE (lower(email)=lower($1) OR customer_id=$2) AND upper(coupon_code)=upper($3) AND status<>'cancelled' LIMIT 1`,
        [form.email, cust.id, priced.coupon.code]);
      if (rowCount) throw new CouponUsedError();
    }

    const { rows: [order] } = await c.query(
      `INSERT INTO orders(number, access_token, customer_id, email, name, phone, fulfillment, address1, address2, city, state, zip,
         subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents, coupon_code, payment_method, notes, lang)
       VALUES($1,$2,$3,lower($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [lib.orderNumber(), lib.token(), cust.id, form.email, form.name, form.phone, form.fulfillment,
       form.address1, form.address2, form.city, form.state, form.zip,
       priced.subtotal, priced.discount, priced.shipping, priced.tax, priced.total,
       priced.coupon ? priced.coupon.code : null, paymentMethod, form.notes, form.lang === 'es' ? 'es' : 'en']);

    for (const l of priced.lines) {
      await c.query('INSERT INTO order_items(order_id, product_id, name, unit_price_cents, qty) VALUES($1,$2,$3,$4,$5)',
        [order.id, l.product.id, l.product.name, l.unitCents, l.qty]);
    }
    return order;
  });
  notify.lowStockAlert(crossed);
  return order;
}

async function markPaid(orderId) {
  return one(`UPDATE orders SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 AND status='pending' RETURNING *`, [orderId]);
}

/** Cancels an order and puts its stock (and coupon use) back. Idempotent. */
async function cancelOrder(orderId) {
  return tx(async (c) => {
    const { rows: [o] } = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!o || o.status === 'cancelled') return o;
    const { rows: items } = await c.query('SELECT product_id, qty FROM order_items WHERE order_id=$1', [orderId]);
    for (const it of items) {
      if (it.product_id) await c.query('UPDATE products SET stock = stock + $1 WHERE id=$2', [it.qty, it.product_id]);
    }
    if (o.coupon_code) await c.query('UPDATE coupons SET uses = GREATEST(uses - 1, 0) WHERE upper(code)=upper($1)', [o.coupon_code]);
    const { rows: [u] } = await c.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING *`, [orderId]);
    return u;
  });
}

module.exports = { createOrder, createManualOrder, markPaid, cancelOrder, StockError, CouponUsedError };

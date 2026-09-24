const { tx, one } = require('./db');
const lib = require('./lib');

class StockError extends Error {}

/**
 * Creates an order atomically: locks product rows, re-checks stock, reserves it,
 * counts the coupon use and upserts the customer.
 */
async function createOrder({ priced, form, paymentMethod }) {
  return tx(async (c) => {
    const ids = priced.lines.map((l) => l.product.id);
    const { rows: locked } = await c.query('SELECT id, stock, active FROM products WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    const byId = Object.fromEntries(locked.map((r) => [r.id, r]));
    for (const l of priced.lines) {
      const p = byId[l.product.id];
      if (!p || !p.active || p.stock < l.qty) throw new StockError();
    }
    for (const l of priced.lines) {
      await c.query('UPDATE products SET stock = stock - $1, updated_at = now() WHERE id=$2', [l.qty, l.product.id]);
    }
    if (priced.coupon) {
      const { rowCount } = await c.query(
        'UPDATE coupons SET uses = uses + 1 WHERE id=$1 AND (max_uses IS NULL OR uses < max_uses)', [priced.coupon.id]);
      if (!rowCount) throw new StockError(); // coupon ran out in a race
    }
    const { rows: [cust] } = await c.query(
      `INSERT INTO customers(email,name,phone) VALUES(lower($1),$2,$3)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, phone=COALESCE(NULLIF(EXCLUDED.phone,''), customers.phone)
       RETURNING id`, [form.email, form.name, form.phone]);

    const { rows: [order] } = await c.query(
      `INSERT INTO orders(number, access_token, customer_id, email, name, phone, fulfillment, address1, address2, city, state, zip,
         subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents, coupon_code, payment_method, notes)
       VALUES($1,$2,$3,lower($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [lib.orderNumber(), lib.token(), cust.id, form.email, form.name, form.phone, form.fulfillment,
       form.address1, form.address2, form.city, form.state, form.zip,
       priced.subtotal, priced.discount, priced.shipping, priced.tax, priced.total,
       priced.coupon ? priced.coupon.code : null, paymentMethod, form.notes]);

    for (const l of priced.lines) {
      await c.query('INSERT INTO order_items(order_id, product_id, name, unit_price_cents, qty) VALUES($1,$2,$3,$4,$5)',
        [order.id, l.product.id, l.product.name, l.product.price_cents, l.qty]);
    }
    return order;
  });
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

module.exports = { createOrder, markPaid, cancelOrder, StockError };

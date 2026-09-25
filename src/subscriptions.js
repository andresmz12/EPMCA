// Recurring orders: a logged-in customer sets up a weekly/monthly plan for their
// cart. We never store a card or charge anything automatically — each cycle
// creates a fresh pending order and emails the customer a Clover checkout link
// that they have to click and pay themselves, same as any other order.
const { one, q, all } = require('./db');
const orders = require('./orders');
const clover = require('./clover');
const notify = require('./notify');

const NEXT_CYCLE_SQL = { week: "now() + interval '7 days'", month: "now() + interval '1 month'" };
const intervalSql = (interval) => NEXT_CYCLE_SQL[interval] || NEXT_CYCLE_SQL.month;

function pricedFromPlan(sub) {
  return {
    lines: sub.items.map((it) => ({ product: { id: it.product_id, name: it.name }, unitCents: it.unit_price_cents, qty: it.qty })),
    shipping: sub.shipping_cents, tax: sub.tax_cents, discount: 0,
  };
}

/** Creates this cycle's pending order plus its Clover checkout link. Charges nothing by itself. */
async function generateCycleOrder(sub) {
  const order = await orders.createRecurringOrder(sub);
  const url = await clover.createCheckout(null, order, pricedFromPlan(sub));
  return { order, url };
}

/** Sets up a new recurring plan and returns the first cycle's checkout link (paid live, like a normal order). */
async function createPlan(customer, priced, form, interval, lang) {
  const items = priced.lines.map((l) => ({ product_id: l.product.id, name: l.product.name, unit_price_cents: l.unitCents, qty: l.qty }));
  const sub = await one(
    `INSERT INTO subscriptions(customer_id, interval, items, subtotal_cents, shipping_cents, tax_cents, total_cents,
       fulfillment, address1, address2, city, state, zip, name, phone, email, lang, next_order_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, ${intervalSql(interval)}) RETURNING *`,
    [customer.id, interval, JSON.stringify(items), priced.subtotal, priced.shipping, priced.tax,
     priced.subtotal + priced.shipping + priced.tax, form.fulfillment, form.address1 || '', form.address2 || '',
     form.city || '', form.state || '', form.zip || '', form.name || customer.name, form.phone || customer.phone || '',
     customer.email, lang === 'es' ? 'es' : 'en']);
  return generateCycleOrder(sub);
}

/** Runs from the background jobs: finds due plans, claims each one, and starts its next cycle. */
async function runDueCycles() {
  const due = await all("SELECT id FROM subscriptions WHERE status='active' AND next_order_at <= now()");
  for (const { id } of due) {
    const claimed = await one(
      `UPDATE subscriptions SET next_order_at = CASE WHEN interval='week' THEN now() + interval '7 days' ELSE now() + interval '1 month' END
       WHERE id=$1 AND next_order_at <= now() RETURNING *`, [id]);
    if (!claimed) continue; // already claimed by a concurrent run
    const { order, url } = await generateCycleOrder(claimed);
    await notify.recurringConfirm(claimed, order, url);
  }
}

async function cancel(sub) {
  await q("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [sub.id]);
}

module.exports = { createPlan, runDueCycles, cancel };

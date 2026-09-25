// Recurring orders: a logged-in customer can turn their cart into a Stripe
// subscription (weekly/monthly). The price/items are locked in at signup
// time; every paid invoice creates a matching order automatically.
const key = process.env.STRIPE_SECRET_KEY;
const stripe = key ? require('stripe')(key) : null;
const { one, q, tx } = require('./db');
const lib = require('./lib');
const notify = require('./notify');

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function createCheckout(req, customer, priced, form, interval, lang) {
  const line_items = priced.lines.map((l) => ({
    quantity: l.qty,
    price_data: { currency: 'usd', unit_amount: l.product.price_cents, recurring: { interval }, product_data: { name: l.product.name } },
  }));
  if (priced.shipping > 0) {
    line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: priced.shipping, recurring: { interval }, product_data: { name: 'Delivery' } } });
  }
  if (priced.tax > 0) {
    line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: priced.tax, recurring: { interval }, product_data: { name: 'Sales tax' } } });
  }
  const items = priced.lines.map((l) => ({ product_id: l.product.id, name: l.product.name, unit_price_cents: l.product.price_cents, qty: l.qty }));
  const meta = {
    customer_id: String(customer.id), interval,
    subtotal: String(priced.subtotal), shipping: String(priced.shipping), tax: String(priced.tax),
    total: String(priced.subtotal + priced.shipping + priced.tax),
    fulfillment: form.fulfillment, address1: form.address1 || '', address2: form.address2 || '',
    city: form.city || '', state: form.state || '', zip: form.zip || '',
    name: form.name || customer.name, phone: form.phone || customer.phone || '', email: customer.email,
    items: JSON.stringify(items), lang: lang === 'es' ? 'es' : 'en',
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: customer.email,
    line_items,
    metadata: meta,
    subscription_data: { metadata: meta },
    success_url: `${baseUrl(req)}/account?sub=ok&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl(req)}/account?sub=cancel`,
  });
  return session.url;
}

/** Inserts a new paid order from a subscription's locked-in items. Idempotent per Stripe invoice. */
async function createRecurringOrder(sub, invoiceId) {
  return tx(async (c) => {
    if (invoiceId) {
      const { rows } = await c.query('SELECT * FROM orders WHERE stripe_invoice_id=$1', [invoiceId]);
      if (rows[0]) return { order: rows[0], created: false };
    }
    const { rows: [order] } = await c.query(
      `INSERT INTO orders(number, access_token, customer_id, email, name, phone, fulfillment, address1, address2, city, state, zip,
         subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents, status, payment_method, subscription_id, stripe_invoice_id, lang, paid_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,'paid','stripe',$17,$18,$19, now()) RETURNING *`,
      [lib.orderNumber(), lib.token(), sub.customer_id, sub.email, sub.name, sub.phone, sub.fulfillment,
       sub.address1, sub.address2, sub.city, sub.state, sub.zip,
       sub.subtotal_cents, sub.shipping_cents, sub.tax_cents, sub.total_cents, sub.id, invoiceId || null, sub.lang || 'en']);
    for (const it of sub.items) {
      await c.query('INSERT INTO order_items(order_id, product_id, name, unit_price_cents, qty) VALUES($1,$2,$3,$4,$5)',
        [order.id, it.product_id, it.name, it.unit_price_cents, it.qty]);
      await c.query('UPDATE products SET stock = GREATEST(stock - $1, 0), updated_at=now() WHERE id=$2', [it.qty, it.product_id]);
    }
    return { order, created: true };
  });
}

async function recurringOrderAndNotify(sub, invoiceId) {
  const { order, created } = await createRecurringOrder(sub, invoiceId);
  if (created) notify.orderPaid(order);
}

/** Backup path for the account page, in case the webhook isn't set up yet. */
async function syncFromSession(sessionId) {
  if (!stripe || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'complete') await handleCheckoutCompleted(session);
  } catch (e) {
    console.error('Subscription sync error:', e.message);
  }
}

/** Called from the Stripe webhook when a subscription checkout completes. */
async function handleCheckoutCompleted(session) {
  if (session.mode !== 'subscription') return;
  const meta = session.metadata || {};
  if (!meta.customer_id) return;
  const items = JSON.parse(meta.items || '[]');
  const sub = await one(
    `INSERT INTO subscriptions(customer_id, stripe_subscription_id, interval, items, subtotal_cents, shipping_cents, tax_cents, total_cents,
       fulfillment, address1, address2, city, state, zip, name, phone, email, lang)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (stripe_subscription_id) DO NOTHING RETURNING *`,
    [meta.customer_id, session.subscription, meta.interval, JSON.stringify(items),
     lib.int(meta.subtotal), lib.int(meta.shipping), lib.int(meta.tax), lib.int(meta.total),
     meta.fulfillment, meta.address1, meta.address2, meta.city, meta.state, meta.zip, meta.name, meta.phone, meta.email, meta.lang === 'es' ? 'es' : 'en']);
  if (!sub) return; // webhook retry: already created
  await recurringOrderAndNotify(sub, session.invoice);
}

/** Called from the webhook on every later billing cycle. */
// API versions from 2025-03-31 on moved this under invoice.parent.
function invoiceSubId(invoice) {
  const id = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
  return id && (typeof id === 'string' ? id : id.id);
}

/** invoice.upcoming: heads-up email a few days before a recurring charge. */
async function handleUpcoming(invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const sub = await one("SELECT * FROM subscriptions WHERE stripe_subscription_id=$1 AND status='active'", [subId]);
  if (sub) notify.upcomingRecurring(sub, invoice.next_payment_attempt || invoice.period_end, invoice.amount_due);
}

async function handleInvoicePaid(invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const sub = await one('SELECT * FROM subscriptions WHERE stripe_subscription_id=$1', [subId]);
  if (!sub) return; // first invoice: checkout.session.completed will create it
  await recurringOrderAndNotify(sub, invoice.id);
}

async function handleSubscriptionDeleted(stripeSub) {
  await q("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE stripe_subscription_id=$1 AND status<>'cancelled'", [stripeSub.id]);
}

async function cancel(sub) {
  if (stripe) {
    try { await stripe.subscriptions.cancel(sub.stripe_subscription_id); } catch (e) { /* already gone on Stripe's side */ }
  }
  await q("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [sub.id]);
}

module.exports = { createCheckout, syncFromSession, handleCheckoutCompleted, handleInvoicePaid, handleUpcoming, handleSubscriptionDeleted, cancel };

// Pagos con Stripe (opcional). Si no hay STRIPE_SECRET_KEY, la tienda toma pedidos
// en modo "pago manual" y tú confirmas el pago desde el admin.
const { one } = require('./db');
const orders = require('./orders');
const subscriptions = require('./subscriptions');

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key ? require('stripe')(key) : null;
const enabled = Boolean(stripe);

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function createCheckout(req, order, priced) {
  const line_items = priced.lines.map((l) => ({
    quantity: l.qty,
    price_data: {
      currency: 'usd',
      unit_amount: l.product.price_cents,
      product_data: { name: l.product.name },
    },
  }));
  if (priced.shipping > 0) {
    line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: priced.shipping, product_data: { name: 'Delivery' } } });
  }
  if (priced.tax > 0) {
    line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: priced.tax, product_data: { name: 'Sales tax' } } });
  }
  const params = {
    mode: 'payment',
    customer_email: order.email,
    client_reference_id: String(order.id),
    metadata: { order_id: String(order.id), order_number: order.number },
    line_items,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 31,
    success_url: `${baseUrl(req)}/order/${order.number}?t=${order.access_token}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl(req)}/checkout/cancel?o=${order.number}&t=${order.access_token}`,
  };
  if (priced.discount > 0) {
    const c = await stripe.coupons.create({ amount_off: priced.discount, currency: 'usd', duration: 'once', name: order.coupon_code || 'Discount' });
    params.discounts = [{ coupon: c.id }];
  }
  const s = await stripe.checkout.sessions.create(params);
  await one('UPDATE orders SET stripe_session_id=$1 WHERE id=$2', [s.id, order.id]);
  return s.url;
}

/** Called from the success page so orders get marked paid even if the webhook isn't set up. */
async function syncFromSession(order, sessionId) {
  if (!enabled || !sessionId || order.stripe_session_id !== sessionId || order.status !== 'pending') return order;
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  if (s.payment_status === 'paid') return (await orders.markPaid(order.id)) || order;
  return order;
}

async function webhook(req, res) {
  if (!enabled || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  const s = event.data.object;
  if (event.type === 'checkout.session.completed' && s.mode === 'subscription') {
    await subscriptions.handleCheckoutCompleted(s);
    return res.json({ received: true });
  }
  if (event.type === 'invoice.paid') {
    await subscriptions.handleInvoicePaid(s);
    return res.json({ received: true });
  }
  if (event.type === 'customer.subscription.deleted') {
    await subscriptions.handleSubscriptionDeleted(s);
    return res.json({ received: true });
  }
  const orderId = Number(s.metadata && s.metadata.order_id);
  if (orderId) {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (s.payment_status === 'paid') await orders.markPaid(orderId);
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const o = await one('SELECT status FROM orders WHERE id=$1', [orderId]);
      if (o && o.status === 'pending') await orders.cancelOrder(orderId);
    }
  }
  res.json({ received: true });
}

module.exports = { enabled, createCheckout, syncFromSession, webhook };

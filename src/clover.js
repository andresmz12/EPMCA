// Pagos con Clover Hosted Checkout (opcional). Reemplaza a Stripe para pagos
// de una sola vez. Si no hay credenciales de Clover, la tienda cae en modo
// "pago manual" igual que antes (o usa Stripe si esa integración sigue activa).
//
// Variables de entorno necesarias (ver panel de developer.clover.com):
//   CLOVER_MERCHANT_ID        - id del comercio (Merchant Dashboard)
//   CLOVER_ECOMM_API_TOKEN    - token privado de Ecommerce API (integración "Hosted Checkout")
//   CLOVER_ENV                - 'sandbox' o 'production' (default: production)
//   CLOVER_WEBHOOK_SECRET     - clave de firma configurada en Hosted Checkout > Webhooks
//
// Estas credenciales no existen todavía (no hay cuenta Clover creada); este
// módulo queda listo para activarse en cuanto se agreguen a Railway, sin tocar
// más código. Los nombres exactos de campos/endpoints deben verificarse contra
// el Merchant Dashboard real la primera vez que se pruebe en sandbox.
const crypto = require('crypto');
const { one } = require('./db');
const orders = require('./orders');
const notify = require('./notify');

const merchantId = process.env.CLOVER_MERCHANT_ID;
const apiToken = process.env.CLOVER_ECOMM_API_TOKEN;
const webhookSecret = process.env.CLOVER_WEBHOOK_SECRET;
const enabled = Boolean(merchantId && apiToken);

const API_BASE = process.env.CLOVER_ENV === 'sandbox' ? 'https://sandbox.dev.clover.com' : 'https://api.clover.com';

async function markPaidAndNotify(orderId, base) {
  const paid = await orders.markPaid(orderId);
  if (paid) notify.orderPaid(paid, base);
  return paid;
}

// req is null when called from a background job (recurring orders); PUBLIC_URL
// must be set in that case, same as it already is for every other background email.
function baseUrl(req) {
  const url = process.env.PUBLIC_URL || (req && `${req.protocol}://${req.get('host')}`);
  if (!url) throw new Error('PUBLIC_URL is not set (required outside a request context)');
  return url.replace(/\/$/, '');
}

async function cloverFetch(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
      'X-Clover-Merchant-Id': merchantId,
      ...(options && options.headers),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Clover ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function createCheckout(req, order, priced) {
  const lineItems = priced.lines.map((l) => ({ name: l.product.name, price: l.unitCents, unitQty: l.qty }));
  if (priced.shipping > 0) lineItems.push({ name: 'Delivery', price: priced.shipping, unitQty: 1 });
  if (priced.tax > 0) lineItems.push({ name: 'Sales tax', price: priced.tax, unitQty: 1 });

  const body = {
    shoppingCart: { lineItems },
    customer: { email: order.email },
    redirectUrls: {
      success: `${baseUrl(req)}/order/${order.number}?t=${order.access_token}&clover_checkout_id={checkoutSessionId}`,
      failure: `${baseUrl(req)}/checkout/cancel?o=${order.number}&t=${order.access_token}`,
      cancel: `${baseUrl(req)}/checkout/cancel?o=${order.number}&t=${order.access_token}`,
    },
    externalReferenceId: String(order.id),
  };
  const resp = await cloverFetch('/invoicingcheckoutservice/v1/checkouts', { method: 'POST', body: JSON.stringify(body) });
  await one('UPDATE orders SET clover_checkout_id=$1 WHERE id=$2', [resp.checkoutSessionId, order.id]);
  return resp.href;
}

/** Called from the success page so orders get marked paid even if the webhook isn't set up. */
async function syncFromSession(order, checkoutSessionId, base) {
  if (!enabled || !checkoutSessionId || order.clover_checkout_id !== checkoutSessionId || order.status !== 'pending') return order;
  try {
    const session = await cloverFetch(`/invoicingcheckoutservice/v1/checkouts/${checkoutSessionId}`, { method: 'GET' });
    if (session.status === 'PAID' || session.paymentStatus === 'PAID') return (await markPaidAndNotify(order.id, base)) || order;
  } catch (e) {
    console.error('Clover sync error:', e.message);
  }
  return order;
}

function verifySignature(req) {
  if (!webhookSecret) return false;
  const signature = req.get('X-Clover-Signature') || req.get('Clover-Signature');
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function webhook(req, res) {
  if (!enabled || !webhookSecret) return res.status(400).send('Webhook not configured');
  if (!verifySignature(req)) return res.status(400).send('Invalid signature');
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Bad payload');
  }
  const orderId = Number(event.externalReferenceId || (event.checkout && event.checkout.externalReferenceId));
  const status = event.status || (event.checkout && event.checkout.status);
  if (orderId && status === 'PAID') {
    await markPaidAndNotify(orderId, `${req.protocol}://${req.get('host')}`);
  } else if (orderId && (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED')) {
    const o = await one('SELECT status FROM orders WHERE id=$1', [orderId]);
    if (o && o.status === 'pending') await orders.cancelOrder(orderId);
  }
  res.json({ received: true });
}

module.exports = { enabled, createCheckout, syncFromSession, webhook };

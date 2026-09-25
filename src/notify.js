// Transactional emails: order confirmations/updates for customers, alerts for the store.
// Every function swallows its own errors so an email problem never breaks a checkout.
const { all, getSettings } = require('./db');
const { makeT } = require('./i18n');
const lib = require('./lib');
const mail = require('./mail');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Background jobs have no request to take the domain from, so remember the last
// one seen (PUBLIC_URL, when set, always wins).
let lastSeenBase = '';
const rememberBase = (url) => { if (url) lastSeenBase = url; };
const siteUrl = (fallback) => (process.env.PUBLIC_URL || fallback || lastSeenBase || '').trim().replace(/\/$/, '');

function layout(settings, title, bodyHtml, footer) {
  return `<!doctype html><html><body style="margin:0;background:#F5F3EF;font-family:Arial,Helvetica,sans-serif;color:#111214">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#111214;padding:16px 24px;font-size:20px;font-weight:bold;color:#fff">EMPA<span style="color:#EEA331">CALO</span></td></tr>
<tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 14px">${esc(title)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 24px;background:#FBFAF8;font-size:12px;color:#6A6E75">${footer}${settings.business_address ? `<br>${esc(settings.store_name)} · ${esc(settings.business_address)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (url, label) => `<p style="margin:22px 0"><a href="${esc(url)}" style="background:#EEA331;color:#111214;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:4px;display:inline-block">${esc(label)}</a></p>`;

function itemsTable(order, items, t) {
  const row = (a, b, bold) => `<tr><td style="padding:6px 0;${bold ? 'font-weight:bold;border-top:1px solid #DEDBD5' : ''}">${a}</td><td align="right" style="padding:6px 0;${bold ? 'font-weight:bold;border-top:1px solid #DEDBD5' : ''}">${b}</td></tr>`;
  let h = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 4px">';
  for (const it of items) h += row(`${it.qty} × ${esc((order.lang === 'es' && it.name_es) || it.name)}`, lib.money(it.unit_price_cents * it.qty));
  h += row(t('subtotal'), lib.money(order.subtotal_cents), true);
  if (order.discount_cents) h += row(`${t('discount')}${order.coupon_code ? ` (${esc(order.coupon_code)})` : ''}`, `−${lib.money(order.discount_cents)}`);
  h += row(order.fulfillment === 'pickup' ? t('pickup') : t('shipping'), order.shipping_cents ? lib.money(order.shipping_cents) : t('free'));
  if (order.tax_cents) h += row(t('tax'), lib.money(order.tax_cents));
  h += row(t('total'), lib.money(order.total_cents), true);
  return `${h}</table>`;
}

function addressLine(order, settings, t) {
  if (order.fulfillment === 'pickup') return `<p style="font-size:14px"><b>${t('pickup_at')}:</b> ${esc(settings.pickup_address || '—')}</p>`;
  const addr = [order.address1, order.address2, order.city, `${order.state} ${order.zip}`].filter((s) => s && s.trim()).map(esc).join(', ');
  return `<p style="font-size:14px"><b>${t('ship_to')}:</b> ${addr}</p>`;
}

const orderItems = (orderId) => all('SELECT oi.*, p.name_es FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id', [orderId]);

/** kind: pending | paid | shipped | delivered | cancelled */
async function customerOrderEmail(order, kind, base) {
  if (!order.email) return;
  const settings = await getSettings();
  const t = makeT(order.lang);
  const items = await orderItems(order.id);
  const url = `${siteUrl(base)}/order/${order.number}?t=${order.access_token}`;
  const k = kind === 'shipped' && order.fulfillment === 'pickup' ? 'ready' : kind;
  const subject = t(`email_subj_${k}`, { number: order.number });
  let body = `<p>${t('email_hi', { name: esc(order.name.split(' ')[0]) })}</p><p>${t(`email_intro_${k}`)}</p>`;
  if (kind === 'shipped' && order.tracking) {
    const carrier = lib.trackingUrl(order.tracking);
    body += `<p style="font-size:14px"><b>${t('track')}:</b> ${esc(order.tracking)}${carrier ? ` · <a href="${esc(carrier)}">${t('track_link')}</a>` : ''}</p>`;
  }
  if ((kind === 'pending' || kind === 'reminder') && order.payment_method !== 'stripe' && settings.payment_instructions) {
    body += `<div style="background:#FCEFD9;border-radius:4px;padding:12px 14px;font-size:14px;margin:12px 0;white-space:pre-wrap"><b>${t('payment_how')}</b>\n${esc(settings.payment_instructions)}</div>`;
  }
  body += itemsTable(order, items, t) + addressLine(order, settings, t) + button(url, t('email_view_order'));
  const footer = t('email_footer', { email: esc(settings.support_email) });
  await mail.send({ to: order.email, subject, html: layout(settings, subject, body, footer), replyTo: settings.support_email || undefined });
}

async function storeOrderAlert(order, base) {
  const settings = await getSettings();
  const to = settings.notify_email || settings.support_email;
  if (!to) return;
  const t = makeT('es');
  const items = await orderItems(order.id);
  const subject = `Nuevo pedido ${order.number} · ${lib.money(order.total_cents)} · ${lib.STATUS_ES[order.status]}`;
  const body = `<p><b>${esc(order.name)}</b> · ${esc(order.email || 'sin correo')}${order.phone ? ` · ${esc(order.phone)}` : ''}</p>
<p style="font-size:14px">Pago: ${esc(lib.PAYMENT_ES[order.payment_method] || order.payment_method)}${order.subscription_id ? ' · Pedido recurrente' : ''}${order.notes ? `<br>Notas: ${esc(order.notes)}` : ''}</p>
${itemsTable({ ...order, lang: 'es' }, items, t)}${addressLine(order, settings, t)}${button(`${siteUrl(base)}/admin/orders/${order.id}`, 'Abrir en el admin')}`;
  await mail.send({ to, subject, html: layout(settings, subject, body, 'Aviso automático de tu tienda.'), replyTo: order.email || undefined });
}

const safe = (fn) => (...args) => fn(...args).catch((e) => console.error('Email error:', e.message));

async function storeDigest(d) {
  const settings = await getSettings();
  const to = settings.notify_email || settings.support_email;
  if (!to) return false;
  const base = siteUrl();
  const list = (rows, fn) => (rows.length ? `<ul style="padding-left:18px;font-size:14px">${rows.map((r) => `<li style="margin:4px 0">${fn(r)}</li>`).join('')}</ul>` : '<p style="font-size:14px;color:#6A6E75">Nada pendiente.</p>');
  const link = (o) => `<a href="${esc(base)}/admin/orders/${o.id}">${esc(o.number)}</a>`;
  const body = `<p style="font-size:14px">Ayer: <b>${d.yesterday.orders}</b> pedido(s) pagado(s) · <b>${lib.money(d.yesterday.revenue)}</b></p>
<h3 style="font-size:16px;margin:18px 0 4px">Por despachar (${d.toShip.length})</h3>
${list(d.toShip, (o) => `${link(o)} · ${esc(o.name)} · ${o.fulfillment === 'pickup' ? 'recoge' : `${esc(o.city)}, ${esc(o.state)}`} · pagado hace <b>${o.days} día(s)</b>${o.days >= 2 ? ' <span style="color:#B23">(atrasado)</span>' : ''}`)}
<h3 style="font-size:16px;margin:18px 0 4px">Esperando pago (${d.unpaid.length})</h3>
${list(d.unpaid, (o) => `${link(o)} · ${esc(o.name)} · ${lib.money(o.total_cents)} · hace ${o.days} día(s)`)}
<h3 style="font-size:16px;margin:18px 0 4px">Inventario bajo (${d.lowStock.length})</h3>
${list(d.lowStock, (p) => `${esc(p.name)}: ${p.stock === 0 ? '<b>AGOTADO</b>' : `${p.stock} unidades`}`)}
${button(`${base}/admin/orders?status=paid`, 'Abrir pedidos')}`;
  return mail.send({ to, subject: `Resumen del día · ${d.toShip.length} por despachar · ${d.unpaid.length} sin pagar`, html: layout(settings, 'Resumen del día', body, 'Resumen automático diario. Se puede apagar en Admin → Configuración.') });
}

// A session's cart sat untouched for a couple of hours and we now know an
// email to reach them at (account, or typed at checkout).
async function abandonedCart(row) {
  const settings = await getSettings();
  if (settings.cart_reminder_enabled !== 'true' || !row.email) return;
  const ids = Object.keys(row.items || {}).map(Number).filter(Boolean);
  if (!ids.length) return;
  const products = await all('SELECT id, name, name_es, price_cents, image_id, stock FROM products WHERE id = ANY($1::int[]) AND active', [ids]);
  const t = makeT(row.lang);
  const lines = products
    .map((p) => ({ p, qty: Math.max(0, Math.min(Number(row.items[p.id]) || 0, p.stock || 0)) }))
    .filter((l) => l.qty > 0);
  if (!lines.length) return;
  const base = siteUrl();
  const restoreItems = lines.map((l) => `${l.p.id}:${l.qty}`).join(',');
  const rows = lines.map((l) => `<tr><td style="padding:8px 0;border-bottom:1px solid #EEE;font-size:14px">${esc(row.lang === 'es' && l.p.name_es ? l.p.name_es : l.p.name)} × ${l.qty}</td></tr>`).join('');
  const subject = t('email_subj_cart');
  const body = `<p>${t('email_cart_body')}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
${button(`${base}/cart/restore?items=${encodeURIComponent(restoreItems)}`, t('email_cart_cta'))}`;
  await mail.send({ to: row.email, subject, html: layout(settings, subject, body, t('email_footer', { email: esc(settings.support_email) })) });
}

// Fires the moment an order pushes a product at or below the low-stock line,
// instead of waiting for the next daily digest.
async function lowStockAlert(crossed) {
  if (!crossed.length) return;
  const settings = await getSettings();
  if (settings.lowstock_alert_enabled !== 'true') return;
  const to = settings.notify_email || settings.support_email;
  if (!to) return;
  const base = siteUrl();
  const list = crossed.map((p) => `<li style="margin:4px 0">${esc(p.name)}: ${p.stock === 0 ? '<b>AGOTADO</b>' : `${p.stock} unidades`}</li>`).join('');
  const body = `<p style="font-size:14px">Este pedido dejó estos productos en o por debajo de ${lib.LOW_STOCK_THRESHOLD} unidades:</p>
<ul style="padding-left:18px;font-size:14px">${list}</ul>
${button(`${base}/admin/products`, 'Abrir productos')}`;
  const subject = `Inventario bajo · ${crossed.map((p) => p.name).join(', ')}`;
  return mail.send({ to, subject, html: layout(settings, 'Inventario bajo', body, 'Aviso automático al momento del pedido. Se puede apagar en Admin → Configuración.') });
}

module.exports = {
  rememberBase,
  lowStockAlert: safe(lowStockAlert),
  abandonedCart: safe(abandonedCart),
  // Web order with manual payment: confirm to the customer, alert the store.
  orderPlaced: safe(async (order, base) => { await customerOrderEmail(order, 'pending', base); await storeOrderAlert(order, base); }),
  // Card payment confirmed (Stripe checkout or recurring cycle).
  orderPaid: safe(async (order, base) => { await customerOrderEmail(order, 'paid', base); await storeOrderAlert(order, base); }),
  orderStatus: safe(async (order, base) => {
    if (['paid', 'shipped', 'delivered', 'cancelled', 'pending'].includes(order.status)) await customerOrderEmail(order, order.status, base);
  }),
  // Unpaid manual order after 24h (sent once, from the background jobs).
  paymentReminder: safe(async (order) => customerOrderEmail(order, 'reminder')),
  storeDigest: safe(storeDigest),
  // Stripe's invoice.upcoming, a few days before a recurring charge.
  upcomingRecurring: safe(async (sub, whenUnix, amountCents) => {
    const settings = await getSettings();
    const t = makeT(sub.lang);
    const date = new Date(whenUnix * 1000).toLocaleDateString(sub.lang === 'es' ? 'es-US' : 'en-US', { timeZone: 'America/Chicago', dateStyle: 'long' });
    const items = sub.items.map((it) => `${it.qty} × ${esc(it.name)}`).join(', ');
    const subject = t('email_subj_upcoming', { date });
    const body = `<p>${t('email_hi', { name: esc(sub.name.split(' ')[0]) })}</p><p>${t('email_upcoming_body', { amount: lib.money(amountCents), date, items })}</p>${button(`${siteUrl()}/account`, t('email_upcoming_cta'))}`;
    await mail.send({ to: sub.email, subject, html: layout(settings, subject, body, t('email_footer', { email: esc(settings.support_email) })) });
  }),
  contactMessage: safe(async (msg) => {
    const settings = await getSettings();
    const to = settings.notify_email || settings.support_email;
    if (!to) return;
    const subject = `Mensaje de ${msg.name} desde la web`;
    const body = `<p><b>${esc(msg.name)}</b> · ${esc(msg.email)}${msg.phone ? ` · ${esc(msg.phone)}` : ''}</p><p style="white-space:pre-wrap">${esc(msg.message)}</p><p style="font-size:13px;color:#6A6E75">Responde este correo para contestarle directamente.</p>`;
    await mail.send({ to, subject, html: layout(settings, subject, body, 'Aviso automático de tu tienda.'), replyTo: msg.email });
  }),
  welcome: safe(async (customer, lang, base) => {
    const settings = await getSettings();
    const t = makeT(lang);
    const subject = t('email_welcome_subj', { store: settings.store_name });
    const body = `<p>${t('email_hi', { name: esc(customer.name.split(' ')[0]) })}</p><p>${t('email_welcome_body')}</p>
<p style="font-size:22px;font-weight:bold;letter-spacing:2px;background:#FCEFD9;border:1.5px dashed #D08A1E;padding:12px;text-align:center">WELCOME10</p>${button(siteUrl(base) + '/', t('email_welcome_cta'))}`;
    await mail.send({ to: customer.email, subject, html: layout(settings, subject, body, t('email_footer', { email: esc(settings.support_email) })) });
  }),
  passwordReset: safe(async (customer, link, lang) => {
    const settings = await getSettings();
    const t = makeT(lang);
    const subject = t('email_reset_subj');
    const body = `<p>${t('email_hi', { name: esc(customer.name.split(' ')[0]) })}</p><p>${t('email_reset_body')}</p>${button(link, t('email_reset_cta'))}<p style="font-size:13px;color:#6A6E75">${t('email_reset_ignore')}</p>`;
    await mail.send({ to: customer.email, subject, html: layout(settings, subject, body, t('email_footer', { email: esc(settings.support_email) })) });
  }),
};

const crypto = require('crypto');
const { all, one } = require('./db');

const money = (cents) =>
  '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "$12.50" / "12,50" / "12" -> 1250
function toCents(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const n = Number(String(input).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 20000000) return null;
  return Math.round(n * 100);
}

// Values outside Postgres INT range fall back to the default instead of erroring.
const int = (v, def = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && Math.abs(n) <= 2147483647 ? n : def;
};

// Wholesale/bulk quantity breaks, smallest to largest. A box only has a
// break if its column is set (most don't wholesale at all).
const WHOLESALE_BREAKS = [
  [50, 'wholesale_50_cents'], [100, 'wholesale_100_cents'], [200, 'wholesale_200_cents'],
  [300, 'wholesale_300_cents'], [400, 'wholesale_400_cents'], [500, 'wholesale_500_cents'],
];

/** The per-unit price for this quantity: the best wholesale break the qty
 * qualifies for, or the regular retail price_cents if none applies. */
function unitPriceCents(p, qty) {
  let price = p.price_cents;
  for (const [minQty, col] of WHOLESALE_BREAKS) {
    if (qty >= minQty && p[col] != null) price = p[col];
  }
  return price;
}

/** [{ qty, cents }] for the breaks this product actually has, for display. */
function wholesaleTiers(p) {
  return WHOLESALE_BREAKS.filter(([, col]) => p[col] != null).map(([qty, col]) => ({ qty, cents: p[col] }));
}

const slugify = (s) =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';

const orderNumber = () => 'BX-' + Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(2).toString('hex').toUpperCase();
const token = () => crypto.randomBytes(18).toString('base64url');

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

async function findCoupon(code) {
  if (!code) return null;
  return one('SELECT * FROM coupons WHERE upper(code)=upper($1)', [String(code).trim()]);
}

function couponError(c, subtotal) {
  // Returns an i18n key (+ vars) or null when the coupon is usable.
  if (!c || !c.active) return { key: 'coupon_invalid' };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { key: 'coupon_expired' };
  if (c.max_uses != null && c.uses >= c.max_uses) return { key: 'coupon_limit' };
  if (subtotal < c.min_subtotal_cents) return { key: 'coupon_min', vars: { min: money(c.min_subtotal_cents) } };
  return null;
}

/**
 * Turns the session cart ({productId: qty}) into priced lines + totals,
 * always reading current prices/stock from the DB (never trust the client).
 */
async function priceCart(cart, couponCode, settings, fulfillment = 'delivery') {
  const ids = Object.keys(cart || {}).map(Number).filter(Boolean);
  const products = ids.length
    ? await all('SELECT * FROM products WHERE id = ANY($1::int[]) AND active', [ids])
    : [];
  const lines = [];
  for (const p of products) {
    const qty = Math.max(0, Math.min(int(cart[p.id]), 999));
    if (!qty) continue;
    const unitCents = unitPriceCents(p, qty);
    lines.push({ product: p, qty, unitCents, lineCents: unitCents * qty, overStock: qty > p.stock });
  }
  lines.sort((a, b) => a.product.sort - b.product.sort);

  const subtotal = lines.reduce((s, l) => s + l.lineCents, 0);
  let discount = 0, coupon = null, couponMsg = null;
  if (couponCode) {
    coupon = await findCoupon(couponCode);
    couponMsg = couponError(coupon, subtotal);
    if (couponMsg) coupon = null;
    else discount = coupon.type === 'percent'
      ? Math.round(subtotal * Math.min(coupon.value, 100) / 100)
      : Math.min(coupon.value, subtotal);
  }
  const afterDiscount = subtotal - discount;
  const flat = int(settings.shipping_flat_cents, 0);
  const freeMin = int(settings.free_shipping_min_cents, 0);
  const pickup = fulfillment === 'pickup' && settings.pickup_enabled === 'true';
  const shipping = lines.length === 0 || pickup ? 0 : (freeMin > 0 && afterDiscount >= freeMin ? 0 : flat);
  const taxRate = Number(settings.tax_rate_percent || 0);
  const tax = Math.round(afterDiscount * (Number.isFinite(taxRate) ? taxRate : 0) / 100);
  const total = afterDiscount + shipping + tax;
  const count = lines.reduce((s, l) => s + l.qty, 0);
  return { lines, subtotal, discount, shipping, tax, total, coupon, couponMsg, count, freeMin, pickup };
}

const STATUS_ES = { pending: 'Pendiente', paid: 'Pagado', shipped: 'Enviado', delivered: 'Entregado', cancelled: 'Cancelado' };
const STATUS_EN = { pending: 'Awaiting payment', paid: 'Paid — preparing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
// stripe/manual come from the website; the rest are for orders entered in the admin.
const PAYMENT_ES = {
  stripe: 'Tarjeta en línea (Stripe)', manual: 'Pago manual (web)', cash: 'Efectivo', zelle: 'Zelle',
  transfer: 'Transferencia', card: 'Tarjeta en persona', check: 'Cheque', other: 'Otro',
};
const MANUAL_PAYMENTS = ['cash', 'zelle', 'transfer', 'card', 'check', 'other'];
const LOW_STOCK_THRESHOLD = 20;

// Best-effort carrier link from the tracking number's shape; null if unknown.
function trackingUrl(tracking) {
  const s = String(tracking || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(s)) return `https://www.ups.com/track?tracknum=${s}`;
  if (/^(94|93|92|95)\d{18,20}$/.test(s) || /^[A-Z]{2}\d{9}US$/.test(s)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${s}`;
  if (/^\d{12}$|^\d{15}$/.test(s)) return `https://www.fedex.com/fedextrack/?trknbr=${s}`;
  return null;
}

module.exports = { money, toCents, int, slugify, orderNumber, token, US_STATES, priceCart, findCoupon, couponError, STATUS_ES, STATUS_EN, PAYMENT_ES, MANUAL_PAYMENTS, LOW_STOCK_THRESHOLD, trackingUrl, unitPriceCents, wholesaleTiers };

/**
 * Draws an isometric cardboard box to scale from a "24 × 30 × 36" style string.
 * Used as the product picture when no photo has been uploaded.
 */
function boxSvg(dims, { label = true, fixed = false } = {}) {
  const nums = String(dims || '').match(/\d+(\.\d+)?/g)?.map(Number) || [];
  const [L, W, H] = nums.length >= 3 ? nums : [16, 16, 16];
  const P = (a, b, h) => [(a - b) * 0.866, (a + b) * 0.5 - h];
  const pts = (arr) => arr.map((p) => P(...p)).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const all = [[0,0,0],[L,0,0],[0,W,0],[L,W,0],[0,0,H],[L,0,H],[0,W,H],[L,W,H]].map((p) => P(...p));
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.14;
  // fixed: same scale for every box (so a 12" box looks smaller than a 36" one)
  const FW = 68, FH = 68;
  const vb = (fixed
    ? [(minX + maxX) / 2 - FW / 2, maxY + 4 - FH, FW, FH]
    : [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2]).map((n) => n.toFixed(2)).join(' ');
  const t = Math.min(W * 0.09, 2.2), mid = W / 2;
  const sw = (fixed ? 0.3 : Math.max(maxX - minX, maxY - minY) / 260).toFixed(3);
  const top = pts([[0,0,H],[L,0,H],[L,W,H],[0,W,H]]);
  const left = pts([[0,W,0],[L,W,0],[L,W,H],[0,W,H]]);
  const right = pts([[L,0,0],[L,W,0],[L,W,H],[L,0,H]]);
  const tapeTop = pts([[0,mid-t,H],[L,mid-t,H],[L,mid+t,H],[0,mid+t,H]]);
  const tapeSide = pts([[L,mid-t,H],[L,mid+t,H],[L,mid+t,H*0.72],[L,mid-t,H*0.72]]);
  const seam = pts([[0,mid,H],[L,mid,H]]);
  const [lx, ly] = P(L * 0.5, W, H * 0.45);
  const fs = Math.min(L / 6.5, H / 4).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="Box ${L} x ${W} x ${H} in" class="boxsvg">
<g stroke="#6b4a24" stroke-width="${sw}" stroke-linejoin="round">
<polygon points="${left}" fill="#C8955A"/><polygon points="${right}" fill="#AE7D46"/><polygon points="${top}" fill="#E0B57A"/>
<polyline points="${seam}" fill="none" stroke="#8a6331"/>
<polygon points="${tapeTop}" fill="#EEA331" fill-opacity=".92" stroke="none"/><polygon points="${tapeSide}" fill="#D98F22" fill-opacity=".92" stroke="none"/>
</g>${label ? `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" font-size="${fs}" font-family="Montserrat,Arial,sans-serif" font-weight="700" fill="#5b3d1b" fill-opacity=".75" text-anchor="middle" transform="skewY(30) translate(0 ${(-lx * Math.tan(Math.PI / 6)).toFixed(2)})">${L}×${W}×${H}</text>` : ''}
</svg>`;
}

module.exports.boxSvg = boxSvg;

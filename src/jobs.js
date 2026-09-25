// Background jobs, run every 10 minutes. Each reminder is claimed with an
// UPDATE ... WHERE <not sent yet> first, so it goes out once even across restarts.
const { all, one, clearSettingsCache } = require('./db');
const { cancelOrder } = require('./orders');
const notify = require('./notify');

const TZ = 'America/Chicago';
const DIGEST_HOUR = 8; // local time the daily store summary goes out

// Unpaid Stripe checkouts reserve stock; release it if they were abandoned (backup for the webhook).
async function releaseAbandoned() {
  const stale = await all(`SELECT id FROM orders WHERE status='pending' AND payment_method='stripe' AND created_at < now() - interval '2 hours'`);
  for (const o of stale) await cancelOrder(o.id);
}

// Web orders with manual payment still unpaid after 24h get one reminder.
async function paymentReminders(settings) {
  if (settings.reminder_payment_enabled !== 'true') return;
  const due = await all(
    `SELECT id FROM orders WHERE status='pending' AND payment_method='manual' AND source='web' AND email <> ''
       AND payment_reminder_at IS NULL AND created_at < now() - interval '24 hours' AND created_at > now() - interval '7 days'`);
  for (const { id } of due) {
    const order = await one('UPDATE orders SET payment_reminder_at=now() WHERE id=$1 AND payment_reminder_at IS NULL RETURNING *', [id]);
    if (order) await notify.paymentReminder(order);
  }
}

// Carts left untouched for 2-3 hours with a known email get one reminder.
// The window's upper bound keeps a months-old session from suddenly emailing
// someone once a stale row finally gets noticed.
async function cartReminders(settings) {
  if (settings.cart_reminder_enabled !== 'true') return;
  const due = await all(
    `SELECT session_id, email, lang, items FROM cart_snapshots
     WHERE email IS NOT NULL AND reminded_at IS NULL
       AND updated_at < now() - interval '2 hours' AND updated_at > now() - interval '3 days'`);
  for (const row of due) {
    const claimed = await one('UPDATE cart_snapshots SET reminded_at=now() WHERE session_id=$1 AND reminded_at IS NULL RETURNING session_id', [row.session_id]);
    if (claimed) await notify.abandonedCart(row);
  }
}

async function digestData() {
  const toShip = await all(
    `SELECT id, number, name, city, state, fulfillment, GREATEST(0, floor(extract(epoch FROM now() - COALESCE(paid_at, created_at)) / 86400))::int AS days
     FROM orders WHERE status='paid' ORDER BY COALESCE(paid_at, created_at)`);
  const unpaid = await all(
    `SELECT id, number, name, total_cents, floor(extract(epoch FROM now() - created_at) / 86400)::int AS days
     FROM orders WHERE status='pending' AND payment_method <> 'stripe' ORDER BY created_at`);
  const lowStock = await all('SELECT name, stock FROM products WHERE active AND stock <= 20 ORDER BY stock');
  const yesterday = await one(
    `SELECT count(*)::int AS orders, COALESCE(sum(total_cents),0)::int AS revenue FROM orders
     WHERE status IN ('paid','shipped','delivered') AND (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date - 1`);
  return { toShip, unpaid, lowStock, yesterday };
}

// One summary per day to the store, after DIGEST_HOUR local time.
async function dailyDigest(settings) {
  if (settings.digest_enabled !== 'true') return;
  const now = new Date();
  const hour = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ });
  if (hour < DIGEST_HOUR) return;
  const claimed = await one(`UPDATE settings SET value=$1 WHERE key='digest_last_date' AND value <> $1 RETURNING key`, [today]);
  clearSettingsCache();
  if (!claimed) return;
  await notify.storeDigest(await digestData());
}

async function runAll() {
  const { getSettings } = require('./db');
  const settings = await getSettings();
  for (const job of [releaseAbandoned, () => paymentReminders(settings), () => cartReminders(settings), () => dailyDigest(settings)]) {
    try { await job(); } catch (e) { console.error('Job error:', e.message); }
  }
}

function start() {
  setTimeout(() => runAll(), 30 * 1000).unref();
  setInterval(() => runAll(), 10 * 60 * 1000).unref();
}

module.exports = { start, runAll, digestData };

const { Pool } = require('pg');
const { hashPassword } = require('./auth');
const { isProd } = require('./env');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta la variable DATABASE_URL (conexión a PostgreSQL).');
  process.exit(1);
}

// Railway's internal network doesn't use SSL; public proxies do.
const needsSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';
const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  id SERIAL PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  short_desc TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  dimensions TEXT NOT NULL DEFAULT '',
  pack_size INT NOT NULL DEFAULT 1,
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  compare_at_cents INT,
  stock INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  featured BOOLEAN NOT NULL DEFAULT false,
  sort INT NOT NULL DEFAULT 0,
  image_id INT REFERENCES images(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS name_es TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS short_desc_es TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_es TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS product_images (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_id INT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images(product_id, sort);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address1 TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address2 TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS zip TEXT NOT NULL DEFAULT '';
-- Signup has no email verification, so an account only sees orders placed
-- after it was created; older guest orders stay behind their private link.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;
UPDATE customers SET account_created_at = created_at WHERE password_hash IS NOT NULL AND account_created_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- New admins default to 'owner' with full access so existing single-admin
-- stores aren't locked out; the "add admin" form defaults new invites to
-- limited staff instead.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff'));
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS perm_orders BOOLEAN NOT NULL DEFAULT true;
-- perm_store (old "Tienda": productos + cupones + configuración) is split so
-- staff can manage the catalog without touching site text/images/settings,
-- which stay owner-only. Existing "Tienda" grants become "Productos".
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_users' AND column_name='perm_store')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_users' AND column_name='perm_products') THEN
    ALTER TABLE admin_users RENAME COLUMN perm_store TO perm_products;
  END IF;
END $$;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS perm_products BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('week','month')),
  items JSONB NOT NULL,
  subtotal_cents INT NOT NULL DEFAULT 0,
  shipping_cents INT NOT NULL DEFAULT 0,
  tax_cents INT NOT NULL DEFAULT 0,
  total_cents INT NOT NULL DEFAULT 0,
  fulfillment TEXT NOT NULL DEFAULT 'delivery' CHECK (fulfillment IN ('delivery','pickup')),
  address1 TEXT NOT NULL DEFAULT '',
  address2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(customer_id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS subtotal_cents INT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS shipping_cents INT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS tax_cents INT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS total_cents INT NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS subscription_id INT REFERENCES subscriptions(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reminder_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en';

-- Only a hash of the emailed token is stored.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_stripe_invoice_uidx ON orders(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value INT NOT NULL CHECK (value > 0),
  min_subtotal_cents INT NOT NULL DEFAULT 0,
  max_uses INT,
  uses INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS once_per_customer BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  fulfillment TEXT NOT NULL DEFAULT 'delivery' CHECK (fulfillment IN ('delivery','pickup')),
  address1 TEXT NOT NULL DEFAULT '',
  address2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  subtotal_cents INT NOT NULL,
  discount_cents INT NOT NULL DEFAULT 0,
  shipping_cents INT NOT NULL DEFAULT 0,
  tax_cents INT NOT NULL DEFAULT 0,
  total_cents INT NOT NULL,
  coupon_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  payment_method TEXT NOT NULL DEFAULT 'manual',
  stripe_session_id TEXT,
  tracking TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(lower(email));
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  unit_price_cents INT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0)
);
-- Postgres doesn't index foreign keys automatically; every order page,
-- report and digest query joins on these, so without an index they'd
-- degrade to a sequential scan as the orders table grows.
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items(product_id);

CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_messages_created_idx ON contact_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per browser session with a non-empty cart, so an abandoned-cart
-- reminder can be sent once the customer's email is known (account, or
-- typed at checkout) and the cart has sat untouched for a couple of hours.
CREATE TABLE IF NOT EXISTS cart_snapshots (
  session_id TEXT PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT,
  lang TEXT NOT NULL DEFAULT 'es',
  items JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cart_snapshots_due_idx ON cart_snapshots(updated_at) WHERE reminded_at IS NULL;

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

const DEFAULT_SETTINGS = {
  store_name: process.env.STORE_NAME || 'EMPACALO',
  shipping_flat_cents: '1500',
  free_shipping_min_cents: '15000',
  tax_rate_percent: '0',
  pickup_enabled: 'false',
  pickup_address: '',
  business_address: '',
  support_email: 'info@empacalo.net',
  support_phone: '',
  whatsapp_number: '',
  notify_email: '',
  reminder_payment_enabled: 'true',
  digest_enabled: 'true',
  digest_last_date: '',
  lowstock_alert_enabled: 'true',
  cart_reminder_enabled: 'true',
  payment_instructions: '',
  announcement_en: 'We ship anywhere in the USA · Free shipping on orders over $150',
  announcement_es: 'Enviamos a todo Estados Unidos · Envío gratis en pedidos desde $150',
};

// Precios de ejemplo: cámbialos desde el panel de administración.
const DW_EN = 'Double-wall corrugated cardboard with a 275 lb bursting test. Two layers of fluting make these boxes much stiffer than standard single-wall moving boxes, so they hold their shape when stacked and loaded with heavy items.\n\nShips flat. Assembles in seconds with packing tape.';
const DW_ES = 'Cartón corrugado de doble pared con prueba de estallido de 275 lb. Las dos capas de onda las hacen mucho más rígidas que una caja de mudanza normal: no se deforman al apilarlas ni con peso adentro.\n\nSe envían planas. Se arman en segundos con cinta de embalaje.';
const SEED_PRODUCTS = [
  { slug: 'box-12x12x12', dims: '12" × 12" × 12"', price: 399, stock: 500, featured: false, sort: 1,
    short: 'Books, tools, parts and small heavy items.', short_es: 'Libros, herramientas, repuestos y cosas pesadas pequeñas.' },
  { slug: 'box-16x16x16', dims: '16" × 16" × 16"', price: 599, stock: 500, featured: true, sort: 2,
    short: 'The everyday size for shipping and moving.', short_es: 'El tamaño de todos los días para envíos y mudanzas.' },
  { slug: 'box-24x24x30', dims: '24" × 24" × 30"', price: 1499, stock: 200, featured: false, sort: 3,
    short: 'Small appliances, bedding, bulk shipments.', short_es: 'Electrodomésticos pequeños, cobijas, envíos grandes.' },
  { slug: 'box-24x24x36', dims: '24" × 24" × 36"', price: 1699, stock: 200, featured: false, sort: 4,
    short: 'Tall items: lamps, rolled rugs, décor.', short_es: 'Cosas altas: lámparas, tapetes enrollados, decoración.' },
  { slug: 'box-24x30x36', dims: '24" × 30" × 36"', price: 1899, stock: 150, featured: false, sort: 5,
    short: 'Our largest box for oversized items.', short_es: 'Nuestra caja más grande, para cosas voluminosas.' },
].map((p) => {
  const [a, b, c] = p.dims.match(/\d+/g);
  return { ...p, pack: 1, compare: null, desc: DW_EN, desc_es: DW_ES,
    name: `Double Wall Box ${a}×${b}×${c}"`, name_es: `Caja doble pared ${a}×${b}×${c}"` };
});

async function migrate() {
  const hadOncePerCustomer = (await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='coupons' AND column_name='once_per_customer'")).rowCount > 0;
  await pool.query(SCHEMA);
  // WELCOME10 is advertised as "first order", so make it one-per-customer once.
  if (!hadOncePerCustomer) await pool.query("UPDATE coupons SET once_per_customer=true WHERE upper(code)='WELCOME10'");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n === 0 && process.env.SEED !== 'false') {
    for (const p of SEED_PRODUCTS) {
      await pool.query(
        `INSERT INTO products(slug,name,short_desc,description,dimensions,pack_size,price_cents,compare_at_cents,stock,featured,sort,name_es,short_desc_es,description_es)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [p.slug, p.name, p.short, p.desc, p.dims, p.pack, p.price, p.compare, p.stock, p.featured, p.sort, p.name_es, p.short_es, p.desc_es]
      );
    }
    await pool.query(
      `INSERT INTO coupons(code,type,value,min_subtotal_cents,once_per_customer) VALUES('WELCOME10','percent',10,0,true) ON CONFLICT DO NOTHING`
    );
    console.log('Base de datos inicializada con productos de ejemplo.');
  }
  const noAdmins = (await pool.query('SELECT count(*)::int AS n FROM admin_users')).rows[0].n === 0;
  const envEmail = (process.env.ADMIN_EMAIL || (isProd ? '' : 'admin@empacalo.net')).trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD || (isProd ? '' : 'admin123');
  if (noAdmins && envEmail && envPassword) {
    await pool.query('INSERT INTO admin_users(email, password_hash) VALUES($1,$2) ON CONFLICT (email) DO NOTHING', [envEmail, await hashPassword(envPassword)]);
    console.log(`Admin inicial creado: ${envEmail}`);
  } else if (noAdmins) {
    console.warn('⚠️  No hay administradores. Define ADMIN_EMAIL y ADMIN_PASSWORD y reinicia para crear el primero.');
  }
}

// Settings are read on every page view but change rarely; cache briefly.
let settingsCache = null;
let settingsAt = 0;
async function getSettings() {
  if (settingsCache && Date.now() - settingsAt < 30000) return settingsCache;
  const rows = await all('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  settingsCache = s;
  settingsAt = Date.now();
  return s;
}
const clearSettingsCache = () => { settingsCache = null; };

module.exports = { pool, q, one, all, tx, migrate, getSettings, clearSettingsCache };

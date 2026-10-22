// Consent to receive offers by email. Order/account emails don't need this; promotions do.
const { q } = require('./db');

async function setConsent(email, name, source, optIn) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return;
  if (optIn) {
    await q(
      `INSERT INTO marketing_contacts(email, name, source) VALUES($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE marketing_contacts.name END,
         opted_in_at = CASE WHEN marketing_contacts.opted_out_at IS NOT NULL THEN now() ELSE marketing_contacts.opted_in_at END,
         opted_out_at = NULL`,
      [e, String(name || '').slice(0, 200), source]);
  } else {
    await q('UPDATE marketing_contacts SET opted_out_at = now() WHERE email=$1 AND opted_out_at IS NULL', [e]);
  }
}

module.exports = { setConsent };

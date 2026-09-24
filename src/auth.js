// Password hashing (scrypt, no extra dependency). Kept dependency-free so
// db.js can use it during migrate() without a circular require.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const MAX_LEN = 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(String(password).slice(0, MAX_LEN), salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

// Always runs scrypt, even for unknown users, so response time doesn't reveal
// which emails have accounts.
async function verifyPassword(password, stored) {
  const valid = typeof stored === 'string' && stored.includes(':');
  const [salt, hash] = valid ? stored.split(':') : ['0'.repeat(32), '00'.repeat(64)];
  const check = await scrypt(String(password).slice(0, MAX_LEN), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return valid && check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

module.exports = { hashPassword, verifyPassword };

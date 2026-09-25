// Email through SendGrid's v3 API (no SDK needed). Without SENDGRID_API_KEY the
// store keeps working and emails are only logged, never thrown.
const KEY = (process.env.SENDGRID_API_KEY || '').trim();
const FROM = (process.env.EMAIL_FROM || '').trim();
const FROM_NAME = (process.env.EMAIL_FROM_NAME || 'EMPACALO').trim();
const enabled = Boolean(KEY && FROM);

if (!enabled) console.warn('ℹ️  Emails desactivados: define SENDGRID_API_KEY y EMAIL_FROM para enviarlos.');

const toText = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<(br|\/p|\/tr|\/h\d|\/div)>/gi, '\n')
  .replace(/<\/td>/gi, '   ')
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function send({ to, subject, html, replyTo }) {
  if (!to) return false;
  if (!enabled) {
    console.log(`[email no enviado: falta SendGrid] para=${to} asunto="${subject}"`);
    return false;
  }
  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM, name: FROM_NAME },
    subject,
    content: [{ type: 'text/plain', value: toText(html) }, { type: 'text/html', value: html }],
  };
  if (replyTo) body.reply_to = { email: replyTo };
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.error(`SendGrid ${r.status} para ${to}: ${(await r.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Error enviando email a ${to}:`, e.message);
    return false;
  }
}

module.exports = { enabled, send };

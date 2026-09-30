// Real-time visitor counter. The browser pings every ~30s while a tab is open
// and visible; a visitor is "active" if they pinged in the last 5 minutes.
// Only a random browser id is stored (no IP, name or email).
const { q, one, all } = require('./db');

const TZ = 'America/Chicago';
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|uptime|curl|wget|python|node-fetch|axios|go-http|java\//i;

const deviceOf = (ua) => (/ipad|tablet/i.test(ua) ? 'tablet' : /mobi|iphone|android/i.test(ua) ? 'mobile' : 'desktop');

function sourceOf(ref, host) {
  let h = '';
  try { h = new URL(ref).hostname.replace(/^www\./, ''); } catch { return 'direct'; }
  if (!h || h === host.replace(/^www\./, '').split(':')[0]) return 'direct';
  if (/google\./.test(h)) return 'google';
  if (/facebook\.|fb\.|instagram\.|l\.instagram/.test(h)) return 'facebook/instagram';
  if (/bing\.|duckduckgo\.|yahoo\./.test(h)) return 'search';
  if (/whatsapp|wa\.me/.test(h)) return 'whatsapp';
  if (/tiktok\./.test(h)) return 'tiktok';
  return 'other';
}

async function ping({ vid, path, first, ref, lang }, ua, host) {
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(vid || '') || BOT.test(ua || '')) return false;
  const page = String(path || '/').startsWith('/') ? String(path).slice(0, 200).split('?')[0] : '/';
  const isFirst = first === '1' ? 1 : 0;
  await q(
    `INSERT INTO site_visitors(vid, page, device, source, lang, views) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (vid) DO UPDATE SET last_seen=now(), page=EXCLUDED.page, lang=EXCLUDED.lang, views=site_visitors.views + $6`,
    [vid, page, deviceOf(ua || ''), sourceOf(ref || '', host || ''), lang === 'es' ? 'es' : 'en', isFirst]);
  if (isFirst) {
    await q(`INSERT INTO site_stats_daily(day, views) VALUES((now() AT TIME ZONE '${TZ}')::date, 1)
             ON CONFLICT (day) DO UPDATE SET views = site_stats_daily.views + 1`);
  }
  return true;
}

async function snapshot() {
  const counts = await one(
    `SELECT count(*) FILTER (WHERE last_seen > now() - interval '5 minutes')::int AS now5,
            count(*) FILTER (WHERE last_seen > now() - interval '30 minutes')::int AS min30,
            count(*) FILTER (WHERE (last_seen AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date)::int AS today,
            count(*) FILTER (WHERE last_seen > now() - interval '5 minutes' AND device='mobile')::int AS mobile,
            count(*) FILTER (WHERE last_seen > now() - interval '5 minutes' AND device='desktop')::int AS desktop,
            count(*) FILTER (WHERE last_seen > now() - interval '5 minutes' AND device='tablet')::int AS tablet,
            count(*) FILTER (WHERE last_seen > now() - interval '5 minutes' AND lang='es')::int AS es
     FROM site_visitors WHERE last_seen > now() - interval '2 days'`);
  const views = await all(
    `SELECT day::text, views FROM site_stats_daily WHERE day >= (now() AT TIME ZONE '${TZ}')::date - 1 ORDER BY day DESC`);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const pages = await all(
    `SELECT page, count(*)::int AS n FROM site_visitors WHERE last_seen > now() - interval '5 minutes' GROUP BY page ORDER BY n DESC, page LIMIT 8`);
  const sources = await all(
    `SELECT source, count(*)::int AS n FROM site_visitors WHERE (last_seen AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date GROUP BY source ORDER BY n DESC`);
  return {
    ...counts,
    viewsToday: (views.find((v) => v.day === todayStr) || {}).views || 0,
    viewsYesterday: (views.find((v) => v.day !== todayStr) || {}).views || 0,
    pages, sources,
  };
}

async function purge() {
  await q("DELETE FROM site_visitors WHERE last_seen < now() - interval '30 days'");
  await q("DELETE FROM site_stats_daily WHERE day < (now() AT TIME ZONE 'America/Chicago')::date - 400");
}

module.exports = { ping, snapshot, purge };

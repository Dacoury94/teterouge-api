export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ─── RATE LIMITING ───
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.headers['x-real-ip']
           || 'unknown';

  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    logAttempt(ip, null, false, 'rate_limit');
    res.setHeader('Retry-After', rateCheck.retryAfter);
    return res.status(429).json({
      valid: false,
      error: `Trop de requetes. Reessaie dans ${rateCheck.retryAfter}s.`
    });
  }

  // ─── VALIDATION FORMAT CLE ───
  const key = (req.query.key || '').trim();

  if (!key) {
    logAttempt(ip, null, false, 'missing_key');
    return res.status(400).json({ valid: false, error: 'Cle manquante' });
  }

  // Format attendu : TTR-XXXX-XXXX-XXXX (majuscules + chiffres)
  if (!/^TTR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) {
    logAttempt(ip, key, false, 'invalid_format');
    return res.status(400).json({ valid: false, error: 'Format de cle invalide' });
  }

  // ─── LECTURE SHEET ───
  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1V4BJmx8nWNhdGSC6hyvSCKfp0WUFF6wT3Qjvc3VWufc/export?format=csv';

  try {
    const response = await fetch(SHEET_URL);
    if (!response.ok) throw new Error('Erreur lecture Sheet');

    const csv = await response.text();
    const lines = csv.split('\n').map(l => l.trim()).filter(l => l);
    const headers = lines[0].split(',').map(h => h.trim());

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ''; });

      if (row.cle === key) {
        if (row.statut !== 'actif') {
          logAttempt(ip, key, false, 'inactive');
          return res.status(200).json({
            valid: false, error: 'Licence inactive', statut: row.statut
          });
        }

        const expires = new Date(row.date_expiration);
        const now = new Date();

        if (isNaN(expires.getTime()) || expires < now) {
          logAttempt(ip, key, false, 'expired');
          return res.status(200).json({
            valid: false, error: 'Licence expiree', expires: row.date_expiration
          });
        }

        logAttempt(ip, key, true, 'ok');
        return res.status(200).json({
          valid: true,
          client: row.client,
          email: row.email,
          pack: row.pack,
          expires: row.date_expiration,
          server_time: new Date().toISOString()
        });
      }
    }

    logAttempt(ip, key, false, 'unknown_key');
    return res.status(200).json({ valid: false, error: 'Cle inconnue' });
  } catch (e) {
    logAttempt(ip, key, false, 'server_error');
    return res.status(500).json({ valid: false, error: 'Erreur serveur' });
  }
}

// ─── RATE LIMITING (memoire, reset a chaque cold start) ───
const attempts = new Map(); // IP -> { count, firstAt, bannedUntil }
const RATE_LIMIT = 10;
const RATE_WINDOW = 60_000;
const BAN_DURATION = 300_000;
const MAX_MAP_SIZE = 10_000;

function checkRateLimit(ip) {
  const now = Date.now();

  // Nettoyage si trop d'entrees (eviter fuite memoire)
  if (attempts.size > MAX_MAP_SIZE) {
    attempts.clear();
  }

  const entry = attempts.get(ip) || { count: 0, firstAt: now, bannedUntil: 0 };

  if (entry.bannedUntil && now < entry.bannedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.bannedUntil - now) / 1000)
    };
  }

  if (now - entry.firstAt > RATE_WINDOW) {
    entry.count = 0;
    entry.firstAt = now;
    entry.bannedUntil = 0;
  }

  entry.count++;

  if (entry.count > RATE_LIMIT) {
    entry.bannedUntil = now + BAN_DURATION;
    attempts.set(ip, entry);
    return { allowed: false, retryAfter: Math.ceil(BAN_DURATION / 1000) };
  }

  attempts.set(ip, entry);
  return { allowed: true };
}

// ─── LOG STRUCTURE (apparait dans Vercel > Logs) ───
function logAttempt(ip, key, valid, reason) {
  const entry = {
    ts: new Date().toISOString(),
    ip: (ip || 'unknown').slice(0, 10) + '***',
    key: key ? key.slice(0, 8) + '***' : null,
    valid,
    reason
  };
  console.log('[AUDIT]', JSON.stringify(entry));
}

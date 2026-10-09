export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const key = (req.query.key || '').trim();

  if (!key) {
    return res.status(400).json({ valid: false, error: 'Cle manquante' });
  }

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
          return res.status(200).json({ valid: false, error: 'Licence inactive', statut: row.statut });
        }

        const expires = new Date(row.date_expiration);
        const now = new Date();

        if (isNaN(expires.getTime()) || expires < now) {
          return res.status(200).json({ valid: false, error: 'Licence expiree', expires: row.date_expiration });
        }

        return res.status(200).json({
          valid: true,
          client: row.client,
          email: row.email,
          pack: row.pack,
          expires: row.date_expiration
        });
      }
    }

    return res.status(200).json({ valid: false, error: 'Cle inconnue' });
  } catch (e) {
    return res.status(500).json({ valid: false, error: 'Erreur serveur : ' + e.message });
  }
}

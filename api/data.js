// api/data.js
// Proxies all Supabase reads and writes
// Keeps Supabase keys server-side

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function supabase(method, table, body = null, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
  };
  if (method === 'PATCH' || method === 'POST') headers['Prefer'] = 'return=representation';
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: resp.ok, status: resp.status, data: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { table, id } = req.query;
  if (!table) return res.status(400).json({ error: 'Missing table param' });

  try {
    if (req.method === 'GET') {
      const query = id ? `?id=eq.${id}` : '?order=created_at.desc';
      const result = await supabase('GET', table, null, query);
      return res.status(result.status).json(result.data);
    }

    if (req.method === 'POST') {
      const result = await supabase('POST', table, req.body);
      return res.status(result.status).json(result.data);
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'Missing id for PATCH' });
      const result = await supabase('PATCH', table, req.body, `?id=eq.${id}`);
      return res.status(result.status).json(result.data);
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Missing id for DELETE' });
      const result = await supabase('DELETE', table, null, `?id=eq.${id}`);
      return res.status(result.status).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

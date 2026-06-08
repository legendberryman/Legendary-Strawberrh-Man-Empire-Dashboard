// api/repost-confirm.js
// Toggle a row in repost_confirmations. PK is content_item_id (not id).
//
//   POST   /api/repost-confirm   { content_item_id, platform, note? }  → upsert confirmed=true
//   DELETE /api/repost-confirm?content_item_id=123                      → remove confirmation

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function pg(method, path, body, headers = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type':'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    if (req.method === 'POST') {
      const { content_item_id, platform, note } = req.body || {};
      if (!content_item_id || !platform) {
        return res.status(400).json({ error: 'content_item_id and platform required' });
      }
      const r = await pg(
        'POST',
        'repost_confirmations?on_conflict=content_item_id',
        {
          content_item_id,
          platform,
          confirmed: true,
          confirmed_at: new Date().toISOString(),
          ...(note ? { note } : {}),
        },
        { Prefer: 'resolution=merge-duplicates,return=representation' }
      );
      return res.status(r.status).json(r.data);
    }

    if (req.method === 'DELETE') {
      const cid = req.query.content_item_id;
      if (!cid) return res.status(400).json({ error: 'content_item_id required' });
      const r = await pg('DELETE', `repost_confirmations?content_item_id=eq.${cid}`, null);
      return res.status(r.status).json({ deleted: r.ok });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

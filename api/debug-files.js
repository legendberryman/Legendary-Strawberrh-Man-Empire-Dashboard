import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function getTokens() {
  const { data } = await supabase.from('config').select('value').eq('key', 'youtube_tokens').single();
  if (!data) return null;
  try { return JSON.parse(data.value); } catch { return null; }
}

async function refreshAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  const tokens = { access_token: data.access_token, refresh_token: refreshToken, expiry: Date.now() + (data.expires_in||3600)*1000 };
  await supabase.from('config').upsert({ key: 'youtube_tokens', value: JSON.stringify(tokens) }, { onConflict: 'key' });
  return tokens;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    let tokens = await getTokens();
    if (!tokens) return res.status(401).json({ error: 'not_authenticated' });
    if (Date.now() > tokens.expiry - 60000) tokens = await refreshAccessToken(tokens.refresh_token);

    const testId = req.query.id || 'Pmo2V-T-fwQ';
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=fileDetails,contentDetails,snippet&id=${testId}`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    const d = await r.json();

    const item = d.items?.[0];
    res.status(200).json({
      id: testId,
      title: item?.snippet?.title,
      fileDetails: item?.fileDetails || 'NULL - not returned',
      rawItem: item,
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

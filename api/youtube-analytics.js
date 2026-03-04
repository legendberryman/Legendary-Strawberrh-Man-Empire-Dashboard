// api/youtube-analytics.js
// Fetches real CTR, AVD, retention from YouTube Analytics API
// Uses stored OAuth tokens, auto-refreshes if expired

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

async function getTokens() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.youtube_tokens&select=value`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  if (!rows || !rows.length) return null;
  return JSON.parse(rows[0].value);
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  // Update stored tokens
  const newTokens = {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry: Date.now() + (data.expires_in * 1000),
  };
  await fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.youtube_tokens`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value: JSON.stringify(newTokens) }),
  });
  return newTokens;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { videoIds, days = 28 } = req.query;
  if (!videoIds) return res.status(400).json({ error: 'Missing videoIds' });

  try {
    let tokens = await getTokens();
    if (!tokens) return res.status(401).json({ error: 'not_authenticated', authUrl: getAuthUrl() });

    // Refresh if expired
    if (Date.now() > tokens.expiry - 60000) {
      tokens = await refreshAccessToken(tokens.refresh_token);
    }

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const ids = videoIds.split(',');

    // Fetch analytics for each video
    const results = await Promise.all(ids.map(async (videoId) => {
      const url = `https://youtubeanalytics.googleapis.com/v2/reports?` +
        `ids=channel==MINE` +
        `&startDate=${startDate}` +
        `&endDate=${endDate}` +
        `&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,impressions,impressionClickThroughRate` +
        `&filters=video==${videoId}` +
        `&dimensions=video`;

      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` },
      });
      const data = await r.json();

      if (!data.rows || !data.rows.length) return { id: videoId, noData: true };

      const row = data.rows[0];
      // columns: video, views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, impressions, impressionClickThroughRate
      return {
        id: videoId,
        views: row[1] || 0,
        estimatedMinutes: row[2] || 0,
        avd_sec: Math.round(row[3] || 0),
        avgpct: parseFloat((row[4] || 0).toFixed(2)),
        subs: row[5] || 0,
        impressions: row[6] || 0,
        ctr: parseFloat(((row[7] || 0) * 100).toFixed(2)), // API returns decimal e.g. 0.048 → 4.8%
      };
    }));

    return res.status(200).json({ videos: results, period: `${days}d`, updated: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: 'https://legendary-strawberrh-man-empire-das.vercel.app/api/auth/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

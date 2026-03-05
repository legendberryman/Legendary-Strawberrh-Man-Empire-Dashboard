import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    redirect_uri: 'https://legendary-strawberrh-man-empire-das.vercel.app/api/auth/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function getTokens() {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'youtube_tokens')
    .single();
  if (error || !data) return null;
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
  const tokens = {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry: Date.now() + (data.expires_in || 3600) * 1000,
  };
  await supabase.from('config').upsert(
    { key: 'youtube_tokens', value: JSON.stringify(tokens) },
    { onConflict: 'key' }
  );
  return tokens;
}

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

async function getChannelVideos(accessToken) {
  // 1. Get channel ID
  const chRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&mine=true',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const chData = await chRes.json();
  const uploadsId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return [];

  // 2. Fetch all videos from uploads playlist (paginate)
  const videos = [];
  let pageToken = '';
  while (true) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=50${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!data.items) break;
    for (const item of data.items) {
      const vid = item.snippet?.resourceId?.videoId;
      if (vid) videos.push({ id: vid, published: item.snippet.publishedAt, title: item.snippet.title, thumbnail: item.snippet.thumbnails?.medium?.url });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    if (videos.length >= 200) break;
  }

  // 3. Get durations + view counts in batches of 50
  const enriched = [];
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map(v => v.id).join(',');
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids}&key=${process.env.YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    const details = {};
    for (const item of (data.items || [])) {
      details[item.id] = {
        dur: parseDuration(item.contentDetails?.duration),
        views: parseInt(item.statistics?.viewCount || 0),
      };
    }
    for (const v of batch) {
      enriched.push({ ...v, ...(details[v.id] || {}) });
    }
  }

  // 4. Filter out Shorts
  return enriched.filter(v => {
    const title = (v.title || '').toLowerCase();
    return !title.includes('#shorts') && !title.includes('#short') && (v.dur || 0) >= 60;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { days = 3650 } = req.query;

  try {
    let tokens = await getTokens();
    if (!tokens) return res.status(401).json({ error: 'not_authenticated', authUrl: getAuthUrl() });

    if (Date.now() > tokens.expiry - 60000) {
      tokens = await refreshAccessToken(tokens.refresh_token);
    }

    const videos = await getChannelVideos(tokens.access_token);

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    // ONE Analytics API call per batch of 200 video IDs using comma-separated filters
    // YouTube Analytics supports up to 500 filters at once
    const analyticsMap = {};
    for (let i = 0; i < videos.length; i += 200) {
      const batch = videos.slice(i, i + 200);
      const filterStr = batch.map(v => `video==${v.id}`).join(',');
      const url = `https://youtubeanalytics.googleapis.com/v2/reports?` +
        `ids=channel==MINE` +
        `&startDate=${startDate}` +
        `&endDate=${endDate}` +
        `&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,impressions,impressionClickThroughRate` +
        `&filters=${encodeURIComponent(filterStr)}` +
        `&dimensions=video` +
        `&maxResults=200`;

      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const data = await r.json();

      for (const row of (data.rows || [])) {
        // row: [videoId, views, estimatedMinutes, avgViewDuration, avgViewPct, subs, impressions, ctr]
        analyticsMap[row[0]] = {
          views: row[1] || 0,
          avd_sec: Math.round(row[3] || 0),
          avgpct: parseFloat((row[4] || 0).toFixed(2)),
          impressions: row[6] || 0,
          ctr: parseFloat(((row[7] || 0) * 100).toFixed(2)),
        };
      }
    }

    // Merge
    const results = videos.map(video => {
      const posted = video.published ? video.published.split('T')[0] : null;
      const daysOld = posted ? Math.round((Date.now() - new Date(posted).getTime()) / 86400000) : 0;
      const a = analyticsMap[video.id];
      return {
        id: video.id,
        title: video.title,
        posted,
        days: daysOld,
        dur: video.dur || 0,
        views: a ? a.views : (video.views || 0),
        avd_sec: a ? a.avd_sec : 0,
        avgpct: a ? a.avgpct : 0,
        impressions: a ? a.impressions : 0,
        ctr: a ? a.ctr : 0,
        thumbnail: video.thumbnail,
        era: posted && posted >= '2025-10-01' ? 'serious' : 'casual',
        noAnalytics: !a,
      };
    });

    res.status(200).json({ videos: results, period: 'all time' });

  } catch (e) {
    console.error('YouTube analytics error:', e);
    res.status(500).json({ error: e.message });
  }
}

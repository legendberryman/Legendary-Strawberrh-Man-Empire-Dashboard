import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

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

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso||'');
  if (!m) return 0;
  return (parseInt(m[1]||0)*3600)+(parseInt(m[2]||0)*60)+parseInt(m[3]||0);
}

async function getVideoList(accessToken) {
  // Get uploads playlist
  const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', { headers: { Authorization: `Bearer ${accessToken}` } });
  const chData = await chRes.json();
  const uploadsId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('No uploads playlist');

  // Paginate ALL videos
  const videos = [];
  const seenIds = new Set();
  let pageToken = null;
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=50${pageToken ? '&pageToken='+pageToken : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json();
    for (const item of (d.items||[])) {
      const vid = item.snippet?.resourceId?.videoId;
      if (vid && !seenIds.has(vid)) { // deduplicate with Set (O(1))
        seenIds.add(vid);
        videos.push({ id: vid, title: item.snippet.title, published: item.snippet.publishedAt, thumbnail: item.snippet.thumbnails?.medium?.url });
      }
    }
    pageToken = d.nextPageToken || null;
  } while (pageToken);

  return videos;
}

async function enrichWithDetails(videos, accessToken) {
  const detailsMap = {};
  for (let i = 0; i < videos.length; i += 50) {
    const ids = videos.slice(i, i+50).map(v => v.id).join(',');
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,fileDetails&id=${ids}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json();
    for (const item of (d.items||[])) {
      detailsMap[item.id] = {
        dur: parseDuration(item.contentDetails?.duration),
        views: parseInt(item.statistics?.viewCount||0),
        file: item.fileDetails?.fileName || null,
      };
    }
  }
  return detailsMap;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const forceRefresh = req.query.refresh === '1';

  try {
    let tokens = await getTokens();
    if (!tokens) return res.status(401).json({ error: 'not_authenticated', authUrl: getAuthUrl() });
    if (Date.now() > tokens.expiry - 60000) tokens = await refreshAccessToken(tokens.refresh_token);

    // ── Check cache (valid for 6 hours) ───────────────────────────────────
    if (!forceRefresh) {
      const { data: cached } = await supabase.from('config').select('value').eq('key', 'youtube_video_cache_v2').single();
      if (cached) {
        try {
          const cache = JSON.parse(cached.value);
          const ageHours = (Date.now() - cache.timestamp) / 3600000;
          if (ageHours < 6) {
            // Validate cache has real analytics — if >90% have 0 CTR, it's bad cache
            const zeroCtr = cache.videos.filter(v => v.ctr === 0).length;
            const badCache = zeroCtr > cache.videos.length * 0.9;
            if (!badCache) {
              return res.status(200).json({ videos: cache.videos, period: 'all time', cached: true, cacheAge: Math.round(ageHours*10)/10 });
            }
            // Fall through to fresh fetch if bad cache
          }
        } catch(e) {}
      }
    }

    // ── Full fresh fetch ───────────────────────────────────────────────────
    const accessToken = tokens.access_token;
    const allVideos = await getVideoList(accessToken);
    const detailsMap = await enrichWithDetails(allVideos, accessToken);

    // Filter shorts
    const longform = allVideos.filter(v => {
      const title = (v.title||'').toLowerCase();
      const dur = detailsMap[v.id]?.dur || 0;
      return !title.includes('#shorts') && !title.includes('#short') && dur >= 60;
    });

    // Analytics for ALL longform videos — batches of 10 parallel
    const endDate = new Date().toISOString().split('T')[0];
    const analyticsMap = {};
    for (let i = 0; i < longform.length; i += 10) {
      const batch = longform.slice(i, i+10);
      await Promise.all(batch.map(async (video) => {
        try {
          const url = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2020-01-01&endDate=${endDate}&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,impressions,impressionClickThroughRate&filters=video==${video.id}&dimensions=video`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          const d = await r.json();
          if (d.rows?.[0]) {
            const row = d.rows[0];
            analyticsMap[video.id] = {
              avd_sec: Math.round(row[3]||0),
              avgpct: parseFloat((row[4]||0).toFixed(2)),
              ctr: parseFloat(((row[7]||0)*100).toFixed(2)),
            };
          }
        } catch(e) {}
      }));
    }

    // Build results
    const results = longform.map(v => {
      const det = detailsMap[v.id]||{};
      const an = analyticsMap[v.id];
      const posted = v.published ? v.published.split('T')[0] : null;
      const daysOld = posted ? Math.round((Date.now()-new Date(posted).getTime())/86400000) : 0;
      return {
        id: v.id, title: v.title, file: det.file||null, posted, days: daysOld,
        dur: det.dur||0, views: det.views||0,
        avd_sec: an?.avd_sec||0, avgpct: an?.avgpct||0, ctr: an?.ctr||0,
        thumbnail: v.id ? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` : v.thumbnail,
        era: posted && posted >= '2025-10-01' ? 'serious' : 'casual',
      };
    });

    // Save to cache
    await supabase.from('config').upsert(
      { key: 'youtube_video_cache_v2', value: JSON.stringify({ videos: results, timestamp: Date.now() }) },
      { onConflict: 'key' }
    );

    res.status(200).json({ videos: results, period: 'all time', cached: false });

  } catch(e) {
    console.error('YouTube API error:', e);
    // Try to serve stale cache on error
    try {
      const { data: cached } = await supabase.from('config').select('value').eq('key', 'youtube_video_cache_v2').single();
      if (cached) {
        const cache = JSON.parse(cached.value);
        return res.status(200).json({ videos: cache.videos, period: 'all time', cached: true, stale: true });
      }
    } catch(e2) {}
    res.status(500).json({ error: e.message });
  }
}

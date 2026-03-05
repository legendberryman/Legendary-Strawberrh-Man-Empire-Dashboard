// api/youtube-analytics.js
// Fetches real video list from YouTube Data API, then gets analytics via OAuth
// Fully automatic - no video IDs needed from frontend

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const API_KEY = process.env.YOUTUBE_API_KEY;

async function getTokens() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.youtube_tokens&select=value`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  if (!rows || !rows.length) return null;
  return JSON.parse(rows[0].value);
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.google.com/token', {
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

async function getChannelVideos(accessToken) {
  // Step 1: get channel ID
  const chRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const chData = await chRes.json();
  if (!chData.items || !chData.items.length) throw new Error('No channel found');
  const channelId = chData.items[0].id;

  // Step 2: get uploads playlist ID
  const uploadsPlaylistId = chData.items[0].id.replace('UC', 'UU');

  // Step 3: fetch all videos from uploads playlist (up to 200)
  let videos = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50${pageToken ? '&pageToken=' + pageToken : ''}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    if (data.items) {
      videos = videos.concat(data.items.map(item => ({
        id: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        published: item.snippet.publishedAt,
        thumbnail: item.snippet.thumbnails?.medium?.url || '',
      })));
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken && videos.length < 200);

  // Step 4: get durations for all videos
  const ids = videos.map(v => v.id).join(',');
  const detailRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids}&key=${API_KEY}`
  );
  const detailData = await detailRes.json();
  if (detailData.items) {
    detailData.items.forEach(item => {
      const v = videos.find(x => x.id === item.id);
      if (v) {
        // Parse ISO 8601 duration to seconds
        const dur = item.contentDetails.duration;
        const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        v.dur = ((parseInt(match[1]||0)*3600) + (parseInt(match[2]||0)*60) + parseInt(match[3]||0));
        v.views = parseInt(item.statistics.viewCount || 0);
      }
    });
  }

  // Filter out Shorts (under 62 seconds)
  videos = videos.filter(v => (v.dur || 0) >= 62);
  return videos;
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

    // Get real video list from YouTube
    const videos = await getChannelVideos(tokens.access_token);

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    // Get analytics for all videos in batches of 10
    const results = [];
    for (let i = 0; i < videos.length; i += 10) {
      const batch = videos.slice(i, i + 10);
      await Promise.all(batch.map(async (video) => {
        try {
          const url = `https://youtubeanalytics.googleapis.com/v2/reports?` +
            `ids=channel==MINE` +
            `&startDate=${startDate}` +
            `&endDate=${endDate}` +
            `&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,impressions,impressionClickThroughRate` +
            `&filters=video==${video.id}` +
            `&dimensions=video`;

          const r = await fetch(url, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}` },
          });
          const data = await r.json();

          const posted = video.published ? video.published.split('T')[0] : null;
          const daysOld = posted ? Math.round((Date.now() - new Date(posted).getTime()) / 86400000) : 0;

          if (!data.rows || !data.rows.length) {
            // No analytics data — still include with Data API views
            results.push({
              id: video.id,
              title: video.title,
              posted: posted,
              days: daysOld,
              dur: video.dur || 0,
              views: video.views || 0,
              avd_sec: 0,
              avgpct: 0,
              subs: 0,
              impressions: 0,
              ctr: 0,
              thumbnail: video.thumbnail,
              era: posted && posted >= '2025-10-01' ? 'serious' : 'casual',
              noAnalytics: true,
            });
            return;
          }

          const row = data.rows[0];
          results.push({
            id: video.id,
            title: video.title,
            posted: posted,
            days: daysOld,
            dur: video.dur || 0,
            views: row[1] || video.views || 0,
            avd_sec: Math.round(row[3] || 0),
            avgpct: parseFloat((row[4] || 0).toFixed(2)),
            subs: row[5] || 0,
            impressions: row[6] || 0,
            ctr: parseFloat(((row[7] || 0) * 100).toFixed(2)),
            thumbnail: video.thumbnail,
            era: posted && posted >= '2025-10-01' ? 'serious' : 'casual',
          });
        } catch(e) {
          results.push({ ...video, noData: true });
        }
      }));
    }

    return res.status(200).json({
      videos: results,
      period: `${days}d`,
      updated: new Date().toISOString(),
      total: results.length,
    });

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

// api/youtube.js
// Fetches YouTube video stats via YouTube Data API v3
// Called from the frontend — keeps API key server-side and secure

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: 'Missing ids param' });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'YouTube API key not configured' });

  try {
    // YouTube Data API v3 - get video stats
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet&id=${ids}&key=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'YouTube API error' });
    }

    // Parse into clean format
    const videos = (data.items || []).map(item => ({
      id: item.id,
      title: item.snippet?.title,
      publishedAt: item.snippet?.publishedAt,
      thumbnail: item.snippet?.thumbnails?.medium?.url,
      views: parseInt(item.statistics?.viewCount || 0),
      likes: parseInt(item.statistics?.likeCount || 0),
      comments: parseInt(item.statistics?.commentCount || 0),
      duration: item.contentDetails?.duration, // ISO 8601 e.g. PT4M13S
    }));

    return res.status(200).json({ videos });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

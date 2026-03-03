const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Config
app.get('/api/config', async (req, res) => {
  const { data } = await supabase.from('config').select('*');
  const c = {};
  (data || []).forEach(r => { c[r.key] = r.value });
  res.json({
    hasYoutubeKey: !!c.youtube_api_key,
    hasGoogleKey: !!c.google_api_key,
    hasShopifyToken: !!c.shopify_token,
    channelId: c.channel_id || 'UCE5Qdgrpen7tB4tQ6TdHwUw',
    sheetsId1: c.sheets_id1 || '',
    sheetsId2: c.sheets_id2 || '',
    shopifyDomain: c.shopify_domain || ''
  });
});

app.post('/api/config', async (req, res) => {
  const map = {
    youtubeApiKey: 'youtube_api_key',
    googleApiKey: 'google_api_key',
    shopifyToken: 'shopify_token',
    channelId: 'channel_id',
    sheetsId1: 'sheets_id1',
    sheetsId2: 'sheets_id2',
    shopifyDomain: 'shopify_domain'
  };
  for (const [k, dbk] of Object.entries(map)) {
    if (req.body[k]) await supabase.from('config').upsert({ key: dbk, value: req.body[k] });
  }
  res.json({ ok: true });
});

// YouTube
app.get('/api/youtube/channel', async (req, res) => {
  const { data } = await supabase.from('config').select('*');
  const c = {}; (data || []).forEach(r => { c[r.key] = r.value });
  const key = c.youtube_api_key, channelId = c.channel_id || 'UCE5Qdgrpen7tB4tQ6TdHwUw';
  if (!key) return res.status(400).json({ error: 'No YouTube API key' });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${key}`);
  const d = await r.json();
  res.json(d.items?.[0] || {});
});

app.get('/api/youtube/videos', async (req, res) => {
  const { data } = await supabase.from('config').select('*');
  const c = {}; (data || []).forEach(r => { c[r.key] = r.value });
  const key = c.youtube_api_key, channelId = c.channel_id || 'UCE5Qdgrpen7tB4tQ6TdHwUw';
  if (!key) return res.status(400).json({ error: 'No YouTube API key' });
  const s = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=50&order=date&type=video&key=${key}`);
  const sd = await s.json();
  const ids = (sd.items || []).map(v => v.id.videoId).filter(Boolean).join(',');
  if (!ids) return res.json([]);
  const v = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}&key=${key}`);
  const vd = await v.json();
  res.json(vd.items || []);
});

app.get('/api/youtube/repost-candidates', async (req, res) => {
  const { data } = await supabase.from('config').select('*');
  const c = {}; (data || []).forEach(r => { c[r.key] = r.value });
  const key = c.youtube_api_key, channelId = c.channel_id || 'UCE5Qdgrpen7tB4tQ6TdHwUw';
  if (!key) return res.status(400).json({ error: 'No YouTube API key' });
  const s = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=50&order=viewCount&type=video&key=${key}`);
  const sd = await s.json();
  const ids = (sd.items || []).map(v => v.id.videoId).filter(Boolean).join(',');
  if (!ids) return res.json([]);
  const v = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}&key=${key}`);
  const vd = await v.json();
  const { data: seanData } = await supabase.from('video_data').select('*');
  const sm = {}; (seanData || []).forEach(r => { sm[r.video_id] = r });
  const now = new Date();
  const candidates = (vd.items || [])
    .map(v => {
      const days = Math.floor((now - new Date(v.snippet.publishedAt)) / 86400000);
      const views = parseInt(v.statistics.viewCount || 0);
      return { ...v, daysSince: days, repostScore: Math.round((views / Math.max(days, 1)) * 10) / 10, views48h: sm[v.id]?.views_48h || null };
    })
    .filter(v => v.daysSince > 30 && parseInt(v.statistics.viewCount) > 500)
    .sort((a, b) => b.repostScore - a.repostScore);
  res.json(candidates);
});

// Video data
app.get('/api/video-data', async (req, res) => {
  const { data } = await supabase.from('video_data').select('*').order('updated_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/video-data', async (req, res) => {
  const { error } = await supabase.from('video_data').upsert({ ...req.body, updated_at: new Date().toISOString() }, { onConflict: 'video_id' });
  res.json({ ok: !error, error });
});

// Sheets
app.get('/api/sheets/:sheetId', async (req, res) => {
  const { data } = await supabase.from('config').select('*');
  const c = {}; (data || []).forEach(r => { c[r.key] = r.value });
  const key = c.google_api_key;
  if (!key) return res.status(400).json({ error: 'No Google API key' });
  const range = req.query.range || 'A1:J100';
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${req.params.sheetId}/values/${range}?key=${key}`);
  res.json(await r.json());
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

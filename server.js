const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function cfg(key) {
  const { data } = await supabase.from('config')
    .select('value').eq('key', key).single();
  return data?.value || null;
}

app.get('/api/config', async (req, res) => {
  const { data } = await supabase.from('config').select('*');
  const c = {};
  (data || []).forEach(r => { c[r.key] = r.value; });
  res.json({
    hasYoutubeKey: !!c.youtube_api_key,
    hasGoogleKey: !!c.google_api_key,
    hasShopifyToken: !!c.shopify_token,
    channelId: c.channel_id || 'UCE5Qdgrpen7tB4tQ6TdHwUw',
    shopifyDomain: c.shopify_domain || '',
    sheetsId1: c.sheets_id1 || '',
    sheetsId2: c.sheets_id2 || '',
  });
});

app.post('/api/config', async (req, res) => {
  const map = {
    youtubeApiKey:'youtube_api_key', googleApiKey:'google_api_key',
    shopifyToken:'shopify_token', channelId:'channel_id',
    shopifyDomain:'shopify_domain', sheetsId1:'sheets_id1', sheetsId2:'sheets_id2'
  };
  for (const [k, dbk] of Object.entries(map)) {
    if (req.body[k]) {
      await supabase.from('config').upsert({ key: dbk, value: req.body[k] });
    }
  }
  res.json({ ok: true });
});

app.get('/api/youtube/channel', async (req, res) => {
  const key = await cfg('youtube_api_key');
  const id = await cfg('channel_id') || 'UCE5Qdgrpen7tB4tQ6TdHwUw';
  if (!key) return res.status(400).json({ error: 'No YouTube API key configured' });
  try {
    const r = await axios.get(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${id}&key=${key}`);
    res.json(r.data.items?.[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/videos', async (req, res) => {
  const key = await cfg('youtube_api_key');
  const id = await cfg('channel_id') || 'UCE5Qdgrpen7tB4tQ6TdHwUw';
  if (!key) return res.status(400).json({ error: 'No YouTube API key configured' });
  try {
    const order = req.query.order || 'date';
    const s = await axios.get(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${id}&maxResults=50&order=${order}&type=video&key=${key}`);
    const ids = s.data.items.map(v => v.id.videoId).filter(Boolean).join(',');
    if (!ids) return res.json([]);
    const r = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}&key=${key}`);
    res.json(r.data.items || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/repost-candidates', async (req, res) => {
  const key = await cfg('youtube_api_key');
  const id = await cfg('channel_id') || 'UCE5Qdgrpen7tB4tQ6TdHwUw';
  if (!key) return res.status(400).json({ error: 'No YouTube API key configured' });
  try {
    const s = await axios.get(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${id}&maxResults=50&order=viewCount&type=video&key=${key}`);
    const ids = s.data.items.map(v => v.id.videoId).filter(Boolean).join(',');
    if (!ids) return res.json([]);
    const r = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}&key=${key}`);
    const { data: seanData } = await supabase.from('video_data').select('*');
    const sm = {};
    (seanData||[]).forEach(d => { sm[d.video_id] = d; });
    const now = new Date();
    const candidates = r.data.items.map(v => {
      const days = Math.floor((now - new Date(v.snippet.publishedAt)) / 86400000);
      const views = parseInt(v.statistics.viewCount||0);
      const sean = sm[v.id] || {};
      return { ...v, daysSince: days, repostScore: Math.round((views/Math.max(days,1))*10)/10,
        views48h: sean.views_48h||null, views7d: sean.views_7d||null,
        repostCount: sean.repost_count||0 };
    }).filter(v => v.daysSince > 30 && parseInt(v.statistics.viewCount) > 500)
      .sort((a,b) => b.repostScore - a.repostScore);
    res.json(candidates);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/video-data', async (req, res) => {
  const { data } = await supabase.from('video_data').select('*').order('updated_at',{ascending:false});
  res.json(data || []);
});

app.post('/api/video-data', async (req, res) => {
  const { video_id, video_title, views_48h, views_7d, repost_count, notes, entered_by } = req.body;
  const { error } = await supabase.from('video_data').upsert({
    video_id, video_title, views_48h: parseInt(views_48h)||0,
    views_7d: parseInt(views_7d)||0, repost_count: parseInt(repost_count)||0,
    notes, entered_by: entered_by||'Team', updated_at: new Date().toISOString()
  }, { onConflict: 'video_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/sheets/:sheetId', async (req, res) => {
  const key = await cfg('google_api_key');
  if (!key) return res.status(400).json({ error: 'No Google API key' });
  try {
    const range = req.query.range || 'A1:Z200';
    const r = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${req.params.sheetId}/values/${encodeURIComponent(range)}?key=${key}`);
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shopify/orders', async (req, res) => {
  const token = await cfg('shopify_token');
  const domain = await cfg('shopify_domain');
  if (!token||!domain) return res.status(400).json({ error: 'Shopify not configured' });
  try {
    const r = await axios.get(`https://${domain}/admin/api/2024-01/orders.json?status=any&limit=50`,
      { headers: { 'X-Shopify-Access-Token': token } });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes', async (req, res) => {
  const { data } = await supabase.from('team_notes').select('*').order('created_at',{ascending:false}).limit(30);
  res.json(data || []);
});

app.post('/api/notes', async (req, res) => {
  const { content, author, note_type } = req.body;
  const { error } = await supabase.from('team_notes').insert({ content, author, note_type: note_type||'general' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🍓 LSM Dashboard: http://localhost:${PORT}`));

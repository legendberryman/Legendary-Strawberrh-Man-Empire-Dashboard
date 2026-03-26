import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    await supabase.from('config').delete().eq('key', 'youtube_tokens');
    res.status(200).json({ success: true, message: 'Token deleted — re-auth required' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

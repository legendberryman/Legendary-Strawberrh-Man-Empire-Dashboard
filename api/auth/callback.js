// api/auth/callback.js
// Google OAuth callback - exchanges auth code for tokens, stores in Supabase

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?auth_error=' + error);
  }

  if (!code) {
    return res.status(400).send('Missing code');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uri: `https://legendary-strawberrh-man-empire-das.vercel.app/api/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      return res.redirect('/lsm-os.html?auth_error=' + tokens.error);
    }

    // Store tokens in Supabase
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

    await fetch(`${SUPABASE_URL}/rest/v1/config`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        key: 'youtube_tokens',
        value: JSON.stringify({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry: Date.now() + (tokens.expires_in * 1000),
        }),
      }),
    });

    // Redirect back to app with success
    res.redirect('/lsm-os.html?auth_success=1');
  } catch (err) {
    res.redirect('/lsm-os.html?auth_error=' + encodeURIComponent(err.message));
  }
}

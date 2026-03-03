export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path' });

  const SHOP  = process.env.SHOPIFY_DOMAIN  || 'pkxkyy-p3.myshopify.com';
  const TOKEN = process.env.SHOPIFY_TOKEN   || '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';

  try {
    const url = `https://${SHOP}/admin/api/2024-01/${path}`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

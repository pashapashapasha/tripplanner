// Vercel serverless function: GET /api/commute
import { commute } from '../lib/commute.js';

export default async function handler(req, res) {
  try {
    const body = await commute();
    // Let Vercel's CDN share one response across viewers for a short while, which keeps
    // us well under 511.org's 60 requests/hour even with several tabs open.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
    res.status(200).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: e.message });
  }
}

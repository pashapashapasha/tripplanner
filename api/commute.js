// Vercel serverless function: GET /api/commute
// The data module is imported lazily so that even a load-time failure comes back as a
// readable JSON error instead of a bare FUNCTION_INVOCATION_FAILED page.

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  try {
    const { commute } = await import('../lib/commute.js');
    // Let Vercel's CDN share one response across viewers for a short while, which keeps
    // us well under 511.org's 60 requests/hour even with several tabs open.
    send(res, 200, await commute(), 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: `${e.name}: ${e.message}`, stack: e.stack }, 'no-store');
  }
}

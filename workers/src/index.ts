interface Env {
  STATS: KVNamespace;
  STATS_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/jellytunes/updates/latest') return handleUpdateCheck(request, env, ctx);
    if (url.pathname === '/jellytunes/stats') return handleStats(request, env);
    return new Response('Not Found', { status: 404 });
  },
};

async function handleUpdateCheck(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ua = request.headers.get('User-Agent') ?? '';
  // Supports current UA "JellyTunes/1.2.3" and future "JellyTunes/1.2.3 (darwin; arm64)"
  const uaMatch = ua.match(/JellyTunes\/([^\s(]+)(?:\s+\(([^;)]+)(?:;\s*([^)]+))?\))?/);
  const version = uaMatch?.[1] ?? 'unknown';
  const platform = uaMatch?.[2]?.trim() ?? 'unknown';
  const country = (request as unknown as { cf?: { country?: string } }).cf?.country ?? 'XX';
  const optedOut = request.headers.get('X-JT-Analytics-Opt-Out') === '1';

  if (!optedOut && env.STATS) {
    ctx.waitUntil(incrementStats(env.STATS, version, platform, country));
  }

  const githubRes = await fetch(
    'https://api.github.com/repos/tresnola-labs/jellytunes/releases/latest',
    {
      headers: {
        'User-Agent': ua || 'JellyTunes-Worker',
        Accept: 'application/vnd.github+json',
      },
    },
  );
  const text = await githubRes.text();
  return new Response(text, {
    status: githubRes.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function incrementStats(kv: KVNamespace, version: string, platform: string, country: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `${date}:${version}:${platform}:${country}`;
  const current = await kv.get(key);
  await kv.put(key, String(parseInt(current ?? '0', 10) + 1), {
    expirationTtl: 90 * 24 * 60 * 60,
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  if (!env.STATS_API_KEY || request.headers.get('Authorization') !== `Bearer ${env.STATS_API_KEY}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  const { keys } = await env.STATS.list();
  const stats: Record<string, number> = {};

  for (const key of keys) {
    const [date] = key.name.split(':');
    if ((!from || date >= from) && (!to || date <= to)) {
      const v = await env.STATS.get(key.name);
      if (v) stats[key.name] = parseInt(v, 10);
    }
  }

  return new Response(JSON.stringify(stats, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
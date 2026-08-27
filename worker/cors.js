/** Fixed CORS allowlist for cross-origin voice API (GitHub Pages → Worker). */
export function isAllowedOrigin(origin, env) {
  const allowed = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !!origin && allowed.includes(origin);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

export function withCors(response, request, env) {
  const extra = corsHeaders(request, env);
  if (!Object.keys(extra).length) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

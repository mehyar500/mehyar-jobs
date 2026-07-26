// _worker.js
//
// Cloudflare Pages Functions entrypoint. Routes under /api/* resolve
// to files in /functions/api/* via the Pages build. We add a top-level
// OPTIONS handler for CORS preflight on /api/* paths that don't have
// their own onRequest handler.
//
// Pages Functions auto-discovers functions/api/**/index.js etc. This
// file is not strictly required, but it lets us add a wildcard OPTIONS
// fallback.

export const onRequestOptions = async ({ request, env }) => {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-requested-with",
    "access-control-max-age": "86400",
  };
  return new Response(null, { status: 204, headers });
};
// re-deploy with secret_text vars

// jobs.mehyar.us in env (2026-07-26)

// +1 re-deploy (2026-07-26)

// +1 deploy (full env)

// +1 (count query fix)

// Entry point when deployed as a Cloudflare Worker (wrangler.jsonc).
// /api/* goes to the same API the Pages Function uses; everything else is
// served from /public by Workers static assets.
import { handleApi } from './api.js';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};

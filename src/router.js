import whatsappRoutes from './routes/whatsapp.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/webhook')) {
      return whatsappRoutes.fetch(request, env, ctx);
    }

    if (pathname.startsWith('/admin')) {
      return adminRoutes.fetch(request, env, ctx);
    }

    if (pathname.startsWith('/api')) {
      return apiRoutes.fetch(request, env, ctx);
    }

    // Static site handling via KV (admin dashboard)
    if (env.__STATIC_CONTENT) {
      const asset = await env.__STATIC_CONTENT.fetch(request);
      if (asset.status !== 404) return asset;
    }

    return new Response('Not Found', { status: 404 });
  }
};

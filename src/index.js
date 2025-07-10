import { handleWebhook } from "./whatsapp.js";
import { handleAdminRequest } from "./admin.js";
import { handleApiRequest } from "./api.js";
import { serveStaticAsset } from "@cloudflare/kv-asset-handler";
import { withCORS } from "./utils/cors.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // WhatsApp Webhook
    if (pathname.startsWith("/webhook")) {
      return handleWebhook(request, env, ctx);
    }

    // Admin API
    if (pathname.startsWith("/admin")) {
      return withCORS(() => handleAdminRequest(request, env), request);
    }

    // Public API
    if (pathname.startsWith("/api")) {
      return withCORS(() => handleApiRequest(request, env), request);
    }

    // Static Admin Dashboard assets (from Wrangler KV site binding)
    try {
      return await serveStaticAsset(request, env, ctx);
    } catch (err) {
      return new Response("Not Found", { status: 404 });
    }
  }
};

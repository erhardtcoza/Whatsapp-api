// src/index.js
import { handleWhatsAppWebhook } from "./routes/whatsapp.js";
import { handleAdminApi } from "./routes/admin.js";
import { handleGeneralApi } from "./routes/api.js";
import { handleCORS } from "./utils/cors.js";

// Main Worker entry point
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight CORS handling
    if (request.method === "OPTIONS") {
      return handleCORS(request);
    }

    // WhatsApp webhook
    if (pathname === "/webhook") {
      return handleWhatsAppWebhook(request, env, ctx);
    }

    // Admin panel API
    if (pathname.startsWith("/admin/")) {
      return handleAdminApi(request, env, ctx);
    }

    // General API endpoints
    if (pathname.startsWith("/api/")) {
      return handleGeneralApi(request, env, ctx);
    }

    // Static assets (e.g., /admin frontend)
    if (env.__STATIC_CONTENT) {
      return env.__STATIC_CONTENT.fetch(request);
    }

    // Fallback 404
    return new Response("Not found", { status: 404 });
  },
};

import { handleWhatsApp } from './routes/whatsapp.js';
import { handleAdmin } from './routes/admin.js';
import { handleAPI } from './routes/api.js';

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname.startsWith("/webhook")) {
    return handleWhatsApp(request, env, ctx);
  }

  if (pathname.startsWith("/admin")) {
    return handleAdmin(request, env, ctx);
  }

  if (pathname.startsWith("/api")) {
    return handleAPI(request, env, ctx);
  }

  return new Response("Not Found", { status: 404 });
}

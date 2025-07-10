import { sendWhatsAppMessage } from '../utils/respond.js';
import { isDepartmentOpen, sendClosureMessageWithButton } from '../utils/office.js';
import { handleIncomingMessage } from '../lib/db.js';

export default async function whatsappHandler(request, env, ctx) {
  const url = new URL(request.url);

  // --- WhatsApp webhook verification ---
  if (request.method === "GET") {
    const verify_token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (verify_token === env.VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // --- WhatsApp webhook message handling ---
  if (request.method === "POST") {
    try {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;

      // Delegate the full incoming message logic to a helper
      await handleIncomingMessage(from, msgObj, env);

      return Response.json({ ok: true });
    } catch (error) {
      console.error("Webhook Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Method not allowed response
  return new Response("Method Not Allowed", { status: 405 });
}

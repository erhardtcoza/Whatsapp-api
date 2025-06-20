import { getCustomerByPhone, getCustomerBalance, getCustomerStatus, getLatestInvoice } from './splynx.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WhatsApp webhook verification
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // WhatsApp webhook: message processing
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const type = msgObj.type;
      let userInput = "";

      if (type === "text") userInput = msgObj.text.body.trim();
      else if (type === "image") userInput = "[Image]";
      else if (type === "audio") userInput = "[Audio]";
      else if (type === "document") userInput = "[Document]";
      else userInput = `[Unknown: ${type}]`;

      // Get customer info
      let customer = await getCustomerByPhone(from, env);
      let reply = await routeCommand({ userInput, customer, env });

      // Send WhatsApp reply
      await sendWhatsAppMessage(from, reply, env);

      // Log both user and bot messages in D1
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, ?)`
      ).bind(from, userInput, customer ? "customer" : "lead", now, "incoming").run();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, ?)`
      ).bind(from, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    // (Add your API/dashboard/admin endpoints here...)

    return new Response("Not found", { status: 404 });
  }
};

import { getCustomerByPhone } from './splynx.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// ---- CORS helper function ----
function withCORS(response) {
  response.headers.set("Access-Control-Allow-Origin", "*"); // Or use your dashboard URL for more security
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}
// -----------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- Handle preflight CORS ----
    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }));
    }
    // ------------------------------

    // WhatsApp webhook verification
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN)
        return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // WhatsApp webhook: incoming message
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
      else if (type === "location") userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
      else userInput = `[Unknown: ${type}]`;

      // Get customer (auto-lookup)
      let customer = await getCustomerByPhone(from, env);

      // Route to command logic
      let reply = await routeCommand({ userInput, customer, env });

      // Send reply to WhatsApp
      await sendWhatsAppMessage(from, reply, env);

      // Log user and bot message to D1
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, ?)`
      ).bind(from, userInput, customer ? "customer" : "lead", now, "incoming").run();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, ?)`
      ).bind(from, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    // List chats for admin dashboard
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name,
          MAX(m.timestamp) as last_ts,
          (SELECT body FROM messages m2 WHERE m2.from_number = m.from_number ORDER BY m2.timestamp DESC LIMIT 1) as last_message,
          SUM(CASE WHEN m.direction = 'incoming' AND m.seen IS NULL THEN 1 ELSE 0 END) as unread_count
        FROM messages m
        LEFT JOIN customers c ON c.phone = m.from_number
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // List messages for a chat
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `
        SELECT
          id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number = ?
        ORDER BY timestamp ASC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // Send admin reply
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body)
        return withCORS(new Response("Missing fields", { status: 400 }));

      await sendWhatsAppMessage(phone, body, env);

      // Store message as outgoing
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen) VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(phone, body, "outgoing", now, "outgoing").run();

      return withCORS(Response.json({ ok: true }));
    }

    // Fallback
    return new Response("Not found", { status: 404 });
  }
};

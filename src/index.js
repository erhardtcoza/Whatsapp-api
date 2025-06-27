// src/index.js

import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    //
    // --- WEBHOOKS ---
    //

    // Verification
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) return new Response(challenge);
      return new Response("Forbidden", { status: 403 });
    }

    // Incoming messages
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now = Date.now();
      let userInput = "";
      let media_url = null;
      let location_json = null;

      // Parse message
      switch (msgObj.type) {
        case "text":
          userInput = msgObj.text.body.trim();
          break;
        case "image":
          userInput = "[Image]";
          media_url = msgObj.image?.url || null;
          break;
        case "audio":
          if (msgObj.audio?.voice) {
            const autoReply = "Sorry, we can't process voice notes. Please send text or documents.";
            await sendWhatsAppMessage(from, autoReply, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
               VALUES (?, ?, 'lead', ?, 'incoming', ?)`
            )
              .bind(from, "[Voice Note]", now, msgObj.audio.url)
              .run();
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            )
              .bind(from, autoReply, now)
              .run();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO customers (phone, name, email, verified)
               VALUES (?, '', '', 0)`
            )
              .bind(from)
              .run();
            return Response.json({ ok: true });
          } else {
            userInput = "[Audio]";
            media_url = msgObj.audio?.url || null;
          }
          break;
        case "document":
          userInput = "[Document]";
          media_url = msgObj.document?.url || null;
          break;
        case "location":
          userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
          location_json = JSON.stringify(msgObj.location);
          break;
        default:
          userInput = `[Unknown: ${msgObj.type}]`;
          if (msgObj[msgObj.type]?.url) media_url = msgObj[msgObj.type].url;
      }

      // Lookup customer
      const customer = await env.DB
        .prepare(`SELECT * FROM customers WHERE phone = ?`)
        .bind(from)
        .first();

      // Greetings
      const greetings = ["hi", "hello", "good day", "hey"];
      const lc = userInput.toLowerCase();

      // VERIFIED FLOW
      if (customer && customer.verified === 1) {
        if (greetings.includes(lc)) {
          const first = (customer.name || "").split(" ")[0] || "";
          const reply =
            `Hello ${first}! How can we help you today?\n1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'customer', ?, 'outgoing')`
          )
            .bind(from, reply, now)
            .run();
          return Response.json({ ok: true });
        }
        // Department selection
        let tag = null;
        if (userInput === "1") tag = "support";
        if (userInput === "2") tag = "sales";
        if (userInput === "3") tag = "accounts";
        if (tag) {
          await env.DB.prepare(
            `UPDATE messages SET tag = ? WHERE from_number = ?`
          )
            .bind(tag, from)
            .run();
          const rep = `You've been connected with ${tag}. How may we assist?`;
          await sendWhatsAppMessage(from, rep, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          )
            .bind(from, rep, tag, now)
            .run();
          return Response.json({ ok: true });
        }
      }

      // NEW / UNVERIFIED FLOW
      const prompt =
        "Welcome! Are you an existing Vinet client? If yes, reply with:\n" +
        "`First Last, you@example.com, YourCustomerID`\n" +
        "If not, reply with `new` and we’ll treat you as a lead.";
      await sendWhatsAppMessage(from, prompt, env);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      )
        .bind(from)
        .run();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'unverified', ?, 'outgoing')`
      )
        .bind(from, prompt, now)
        .run();
      return Response.json({ ok: true });
    }

    //
    // --- DASHBOARD API ---
    //

    // List open chats
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `...`; // your existing SQL
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // List closed chats
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `...`;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // List messages in a chat
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `...`;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // Close chat (and notify)
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      const notice = "This chat has been closed. To start a new one, just say hi.";
      await sendWhatsAppMessage(phone, notice, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'system', ?, 'outgoing')`
      ).bind(phone, notice, ts).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Admin sends a reply
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, 'outgoing', ?, 'outgoing', 1)`
      )
        .bind(phone, body, ts)
        .run();
      return withCORS(Response.json({ ok: true }));
    }

    // *** NEW: list all customers for “Send Message” UI ***
    if (url.pathname === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT phone, name FROM customers ORDER BY name`
      ).all();
      return withCORS(Response.json(results));
    }

    // Set tag manually
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Update customer & mark verified
    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`
        INSERT INTO customers (phone, name, customer_id, email, verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone, name, customer_id, email).run();
      return withCORS(Response.json({ ok: true }));
    }

    // Auto-Replies CRUD, Office Hours, Holidays, Flow-Builder, etc.
    // … (keep all of your existing code here) …

    // Serve dashboard
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
      }
      return new Response("Missing dashboard assets", { status: 404 });
    }

    // Fallback
    return new Response("Not found", { status: 404 });
  },
};

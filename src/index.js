import { sendWhatsAppMessage } from './whatsapp.js';

function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/"))
      return withCORS(new Response("OK", { status: 200 }));

    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN)
        return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msg = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return Response.json({ ok: true });

      const from = msg.from;
      const type = msg.type;
      const now = Date.now();
      let userInput = "";
      let media_url = null;
      let location_json = null;
      const greetings = ["hi", "hello", "good day", "hey"];

      if (type === "text") {
        userInput = msg.text.body.trim().toLowerCase();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msg.image?.url || null;
      } else if (type === "document") {
        userInput = "[Document]";
        media_url = msg.document?.url || null;
      } else if (type === "audio" && msg.audio?.voice) {
        const reply = "Sorry, voice notes aren't supported. Please use text.";
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url) VALUES (?, ?, 'lead', ?, 'incoming', ?)`)
          .bind(from, "[Voice Note]", now, msg.audio.url || null).run();
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'lead', ?, 'outgoing')`)
          .bind(from, reply, now).run();
        await env.DB.prepare(`INSERT OR IGNORE INTO customers (phone, verified) VALUES (?, 0)`).bind(from).run();
        return Response.json({ ok: true });
      } else if (type === "location") {
        const loc = msg.location;
        userInput = `[Location: ${loc.latitude},${loc.longitude}]`;
        location_json = JSON.stringify(loc);
      } else {
        userInput = `[Unknown: ${type}]`;
      }

      let customer = await env.DB.prepare(`SELECT * FROM customers WHERE phone=?`).bind(from).first();

      if (!customer || customer.verified === 0) {
        if (greetings.includes(userInput)) {
          const reply = "Welcome! Please reply with your name, email, and customer ID. If unsure, just send what you know.";
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(`INSERT OR IGNORE INTO customers (phone, verified) VALUES (?, 0)`).bind(from).run();
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'unverified', ?, 'outgoing')`)
            .bind(from, reply, now).run();
          return Response.json({ ok: true });
        }

        const details = userInput.split(/[,\n]/).map(s => s.trim());
        const [name, email, customer_id] = details;
        await env.DB.prepare(`
          UPDATE customers SET
            name = COALESCE(?, name),
            email = COALESCE(?, email),
            customer_id = COALESCE(?, customer_id)
          WHERE phone = ?
        `).bind(name || null, email || null, customer_id || null, from).run();

        const reply = "Thanks! Our team will verify your details soon.";
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, 'unverified', ?, 'outgoing')`)
          .bind(from, reply, now).run();
        return Response.json({ ok: true });
      }

      if (customer.verified === 1) {
        let tag = "customer";
        if (greetings.includes(userInput)) {
          const reply = `Hi ${customer.name || ""}! How can we assist?\n1. Sales\n2. Accounts\n3. Support`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, 'outgoing')`)
            .bind(from, reply, tag, now).run();
        } else if (["1", "2", "3"].includes(userInput)) {
          tag = userInput === "1" ? "sales" : userInput === "2" ? "accounts" : "support";
          const reply = `You're now chatting with ${tag}. How can we help?`;
          await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from).run();
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction) VALUES (?, ?, ?, ?, 'outgoing')`)
            .bind(from, reply, tag, now).run();
        }
      }

      await env.DB.prepare(`INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json) VALUES (?, ?, ?, ?, 'incoming', ?, ?)`)
        .bind(from, userInput, customer?.verified ? "customer" : "unverified", now, media_url, location_json).run();

      return Response.json({ ok: true });
    }

    // All other routes stay as-is (admin APIs, chat lists, settings)
    return new Response("Not found", { status: 404 });
  }
};

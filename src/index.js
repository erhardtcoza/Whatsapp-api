
import { getCustomerByPhone } from './splynx.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now = Date.now();
      let userInput = "";

      if (msgObj.type === "text") {
        userInput = msgObj.text.body.trim();
      }

      // 1) Lookup session
      const sess = await env.DB.prepare(
        `SELECT email, customer_id, verified, last_seen, department
           FROM sessions WHERE phone = ?`
      ).bind(from).first();

      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      const expired = !sess || sess.verified === 0 || (sess.last_seen + ninetyDays <= now);

      // 2) Authentication flow
      if (expired) {
        const match = userInput.match(/^(\S+)\s+(\S+@\S+\.\S+)$/);
        if (sess && sess.verified === 0 && match) {
          const providedId = match[1];
          const providedEmail = match[2].toLowerCase();
          const customer = await getCustomerByPhone(from, env);

          if (!customer) {
            const leadMsg =
              "We couldn’t find your number. " +
              "Please send your full name, address, and email to create a lead.";
            await sendWhatsAppMessage(from, leadMsg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(from, leadMsg, now).run();
            return Response.json({ ok: true });
          }

          const realId = customer.customer_id;
          const realEmail = (customer.email || "").toLowerCase();

          if (providedId === realId && providedEmail === realEmail) {
            await env.DB.prepare(
              `INSERT INTO sessions
                 (phone, email, customer_id, verified, last_seen, department)
               VALUES (?, ?, ?, 1, ?, NULL)
               ON CONFLICT(phone) DO UPDATE SET
                 email=excluded.email,
                 customer_id=excluded.customer_id,
                 verified=1,
                 last_seen=excluded.last_seen`
            ).bind(from, providedEmail, providedId, now).run();

            const menu =
              "✅ Verified! How can we assist?
" +
              "1. Sales
" +
              "2. Accounts
" +
              "3. Support";
            await sendWhatsAppMessage(from, menu, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, menu, now).run();
            return Response.json({ ok: true });
          } else {
            const hint = `Our records: ID ${realId}, email ${realEmail}.`;
            const retry =
              "❌ Didn’t match.
" +
              `${hint}
` +
              "Please reply exactly with your Customer ID and email.";
            await sendWhatsAppMessage(from, retry, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, retry, now).run();
            return Response.json({ ok: true });
          }
        }

        await env.DB.prepare(
          `INSERT INTO sessions
             (phone, email, customer_id, verified, last_seen, department)
           VALUES (?, '', '', 0, ?, NULL)
           ON CONFLICT(phone) DO UPDATE SET
             verified=0,
             last_seen=excluded.last_seen`
        ).bind(from, now).run();

        const prompt =
          "Welcome! To verify, reply with your Customer ID and email " +
          "(e.g. 12345 you@example.com).";
        await sendWhatsAppMessage(from, prompt, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, prompt, now).run();

        return Response.json({ ok: true });
      }

      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, from).run();

      let media_url = null;
      let location_json = null;
      if (msgObj.type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (msgObj.type === "audio") {
        userInput = "[Audio]";
        media_url = msgObj.audio?.url || null;
      } else if (msgObj.type === "document") {
        userInput = "[Document]";
        media_url = msgObj.document?.url || null;
      } else if (msgObj.type === "location") {
        userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      }

      const customer = await getCustomerByPhone(from, env);
      const reply   = await routeCommand({ userInput, customer, env });
      await sendWhatsAppMessage(from, reply, env);

      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, media_url, location_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        from,
        userInput,
        customer ? "customer" : "lead",
        now,
        "incoming",
        media_url,
        location_json
      ).run();

      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers
           (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();

      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(from, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
};

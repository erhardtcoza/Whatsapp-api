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

    // 1) CORS preflight
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // 2) WhatsApp webhook verification
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token     = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // 3) WhatsApp webhook handler
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const rawFrom = msgObj.from;
      const now     = Date.now();

      // 4) Normalize for Splynx lookup
      let normPhone = rawFrom.replace(/^\+|^0/, "");
      if (!normPhone.startsWith("27")) normPhone = "27" + normPhone;

      // 5) Capture text
      let userInput = "";
      if (msgObj.type === "text") {
        userInput = msgObj.text.body.trim();
      }

      // 6) Lookup local session
      const sess = await env.DB.prepare(
        `SELECT email, customer_id, verified, last_seen, department
           FROM sessions WHERE phone = ?`
      ).bind(rawFrom).first();

      const ninety = 90 * 24 * 60 * 60 * 1000;
      const expired = !sess || sess.verified === 0 || (sess.last_seen + ninety <= now);

      // === AUTH FLOW ===
      if (expired) {
        // match "login, email" or "login email"
        const m = userInput.match(/^(\S+)[\s,]+(\S+@\S+\.\S+)$/);
        if (sess && sess.verified === 0 && m) {
          const providedLogin = m[1];
          const providedEmail = m[2].toLowerCase();
          const customer      = await getCustomerByPhone(normPhone, env);

          if (!customer) {
            // no splynx record → create lead
            const leadMsg = 
              "We couldn’t find your number on file. " +
              "Please send your full name, address, and email to create a lead.";
            await sendWhatsAppMessage(rawFrom, leadMsg, env);
            await env.DB.prepare(
              `INSERT INTO messages
                 (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(rawFrom, leadMsg, now).run();
            return Response.json({ ok: true });
          }

          // verify against login & email
          const realLogin = String(customer.login);
          const realEmail = (customer.email || "").toLowerCase();

          if (providedLogin === realLogin && providedEmail === realEmail) {
            // mark verified
            await env.DB.prepare(
              `INSERT INTO sessions
                 (phone, email, customer_id, verified, last_seen, department)
               VALUES (?, ?, ?, 1, ?, NULL)
               ON CONFLICT(phone) DO UPDATE SET
                 email=excluded.email,
                 customer_id=excluded.customer_id,
                 verified=1,
                 last_seen=excluded.last_seen`
            ).bind(rawFrom, providedEmail, providedLogin, now).run();

            const menu =
              "✅ Verified! How can we assist?\n" +
              "1. Sales\n" +
              "2. Accounts\n" +
              "3. Support";
            await sendWhatsAppMessage(rawFrom, menu, env);
            await env.DB.prepare(
              `INSERT INTO messages
                 (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(rawFrom, menu, now).run();
            return Response.json({ ok: true });
          } else {
            const hint =
              `Our records: login ${realLogin}, email ${realEmail}.`;
            const retry =
              "❌ Didn’t match.\n" +
              `${hint}\n` +
              "Please reply with your login and email (e.g. 000000001, you@example.com).";
            await sendWhatsAppMessage(rawFrom, retry, env);
            await env.DB.prepare(
              `INSERT INTO messages
                 (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(rawFrom, retry, now).run();
            return Response.json({ ok: true });
          }
        }

        // prompt credentials
        await env.DB.prepare(
          `INSERT INTO sessions
             (phone, email, customer_id, verified, last_seen, department)
           VALUES (?, '', '', 0, ?, NULL)
           ON CONFLICT(phone) DO UPDATE SET
             verified=0,
             last_seen=excluded.last_seen`
        ).bind(rawFrom, now).run();

        const prompt =
          "Please provide your Splynx login and email\n" +
          "(e.g. 000000001, you@example.com).";
        await sendWhatsAppMessage(rawFrom, prompt, env);
        await env.DB.prepare(
          `INSERT INTO messages
             (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(rawFrom, prompt, now).run();
        return Response.json({ ok: true });
      }

      // === VERIFIED SESSION ===
      // refresh last_seen
      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, rawFrom).run();

      // department and ticket
      if (!sess.department && userInput) {
        let dept;
        if (userInput === "1") dept = "sales";
        else if (userInput === "2") dept = "accounts";
        else if (userInput === "3") dept = "support";

        if (dept) {
          await env.DB.prepare(
            `UPDATE sessions SET department = ?, last_seen = ? WHERE phone = ?`
          ).bind(dept, now, rawFrom).run();

          const date   = new Date().toISOString().slice(0,10).replace(/-/g,"");
          const ticket = `TKT-${date}-${Math.floor(Math.random()*9000+1000)}`;

          await env.DB.prepare(
            `INSERT INTO chatsessions
               (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(rawFrom, ticket, dept, now).run();

          const ack =
            `✅ Your ticket: *${ticket}* (Dept: ${dept}).\n` +
            `How can we help?`;
          await sendWhatsAppMessage(rawFrom, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages
               (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'ticket', ?, 'outgoing')`
          ).bind(rawFrom, ack, now).run();
          return Response.json({ ok: true });
        }
      }

      // normal message flow
      let media_url = null, location_json = null;
      if (msgObj.type === "image") {
        userInput = "[Image]"; media_url = msgObj.image?.url || null;
      } else if (msgObj.type === "audio") {
        userInput = "[Audio]"; media_url = msgObj.audio?.url || null;
      } else if (msgObj.type === "document") {
        userInput = "[Document]"; media_url = msgObj.document?.url || null;
      } else if (msgObj.type === "location") {
        userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      }

      // fetch customer but do not require phone match
      const customer = await getCustomerByPhone(normPhone, env) || null;
      const reply   = await routeCommand({ userInput, customer, env });
      await sendWhatsAppMessage(rawFrom, reply, env);

      // log incoming
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, media_url, location_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        rawFrom,
        userInput,
        customer ? "customer" : "lead",
        now,
        "incoming",
        media_url,
        location_json
      ).run();

      // ensure customer row exists
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(rawFrom).run();

      // log outgoing
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(rawFrom, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    // --- API endpoints unchanged below ---
    return new Response("Not found", { status: 404 });
  }
};

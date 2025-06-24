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

    // CORS preflight
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // Webhook verification
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token     = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // Webhook handler
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const rawFrom  = msgObj.from;
      const now      = Date.now();

      // 1️⃣ Normalize for Splynx
      let normPhone = rawFrom.replace(/^\+|^0/, "");
      if (!normPhone.startsWith("27")) normPhone = "27" + normPhone;

      // 2️⃣ Get user text
      let userInput = "";
      if (msgObj.type === "text") {
        userInput = msgObj.text.body.trim();
      }

      // 3️⃣ Lookup session
      const sess = await env.DB.prepare(
        `SELECT email, customer_id, verified, last_seen, department
           FROM sessions WHERE phone = ?`
      ).bind(rawFrom).first();

      const ninety = 90 * 24 * 60 * 60 * 1000;
      const expired = !sess || sess.verified === 0 || (sess.last_seen + ninety <= now);

      // 4️⃣ Authentication flow
      if (expired) {
        // a) Pending & matching “ID email”?
        const m = userInput.match(/^(\S+)\s+(\S+@\S+\.\S+)$/);
        if (sess && sess.verified === 0 && m) {
          const providedId    = m[1];
          const providedEmail = m[2].toLowerCase();
          const customer      = await getCustomerByPhone(normPhone, env);

          if (!customer) {
            const leadMsg = "Number not found. Send your name, address & email to create a lead.";
            await sendWhatsAppMessage(rawFrom, leadMsg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(rawFrom, leadMsg, now).run();
            return Response.json({ ok: true });
          }

          // ✅ Pull the correct field
          const realId    = String(customer.id);
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
            ).bind(rawFrom, providedEmail, providedId, now).run();

            const menu =
              "✅ Verified! How can we assist?\n" +
              "1. Sales\n" +
              "2. Accounts\n" +
              "3. Support";
            await sendWhatsAppMessage(rawFrom, menu, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(rawFrom, menu, now).run();
            return Response.json({ ok: true });
          } else {
            const hint  = `Our records: ID ${realId}, email ${realEmail}.`;
            const retry =
              "❌ Didn’t match.\n" +
              `${hint}\n` +
              "Reply with your Customer ID and email exactly.";
            await sendWhatsAppMessage(rawFrom, retry, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(rawFrom, retry, now).run();
            return Response.json({ ok: true });
          }
        }

        // b) First contact / expired → prompt
        await env.DB.prepare(
          `INSERT INTO sessions
             (phone, email, customer_id, verified, last_seen, department)
           VALUES (?, '', '', 0, ?, NULL)
           ON CONFLICT(phone) DO UPDATE SET
             verified=0,
             last_seen=excluded.last_seen`
        ).bind(rawFrom, now).run();

        const prompt =
          "Welcome! To verify, reply with your Customer ID and email " +
          "(e.g. 12345 you@example.com).";
        await sendWhatsAppMessage(rawFrom, prompt, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(rawFrom, prompt, now).run();
        return Response.json({ ok: true });
      }

      // 5️⃣ Verified session → refresh
      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, rawFrom).run();

      // 6️⃣ Department → ticket
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
            `INSERT INTO chatsessions (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(rawFrom, ticket, dept, now).run();

          const ack =
            `✅ Your ticket: *${ticket}* (Dept: ${dept}).\n` +
            `How can we help?`;
          await sendWhatsAppMessage(rawFrom, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'ticket', ?, 'outgoing')`
          ).bind(rawFrom, ack, now).run();
          return Response.json({ ok: true });
        }
      }

      // 7️⃣ Normal chat logic
      let media_url = null, location_json = null;
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

      const customer = await getCustomerByPhone(normPhone, env);
      const reply   = await routeCommand({ userInput, customer, env });
      await sendWhatsAppMessage(rawFrom, reply, env);

      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, media_url, location_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(rawFrom, userInput, customer ? "customer" : "lead", now, "incoming", media_url, location_json).run();

      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(rawFrom).run();

      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(rawFrom, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    // --- API endpoints below unchanged ---
    // ...

    return new Response("Not found", { status: 404 });
  }
};

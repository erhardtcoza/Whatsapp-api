import { getCustomerByPhone } from './splynx.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

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
      let   userInput = "";

      if (msgObj.type === "text") {
        userInput = msgObj.text.body.trim();
      }

      // 1) Normalize for Splynx
      let normPhone = rawFrom.replace(/^\+|^0/, "");
      if (!normPhone.startsWith("27")) normPhone = "27" + normPhone;

      // 2) Lookup session
      const sess = await env.DB.prepare(
        `SELECT email, customer_id, verified, last_seen, department
           FROM sessions WHERE phone = ?`
      ).bind(rawFrom).first();

      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      const expired    = !sess || sess.verified === 0 || (sess.last_seen + ninetyDays <= now);

      // 3) Authentication flow
      if (expired) {
        const match = userInput.match(/^(\S+)\s+(\S+@\S+\.\S+)$/);
        if (sess && sess.verified === 0 && match) {
          const providedId    = match[1];
          const providedEmail = match[2].toLowerCase();
          const customer      = await getCustomerByPhone(normPhone, env);

          if (!customer) {
            const leadMsg = "We couldn’t find your number in our system. Please send your full name, address and email to create a lead.";
            await sendWhatsAppMessage(rawFrom, leadMsg, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(rawFrom, leadMsg, now).run();
            return Response.json({ ok: true });
          }

          // send debug payload
          await sendWhatsAppMessage(
            rawFrom,
            `🛠 DEBUG (Splynx payload):\n\`\`\`${JSON.stringify(customer, null,2)}\`\`\``,
            env
          );

          // try matching common fields
          const realId    = customer.customer_id ?? customer.id ?? customer.customerid ?? "";
          const realEmail = (customer.email || "").toLowerCase();

          if (providedId === realId && providedEmail === realEmail) {
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
            const retry =
              "❌ Didn’t match. Check the debug above and reply exactly with your Customer ID and email.";
            await sendWhatsAppMessage(rawFrom, retry, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
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
          "Welcome! To verify, reply with your Customer ID and email " +
          "(e.g. 12345 you@example.com).";
        await sendWhatsAppMessage(rawFrom, prompt, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(rawFrom, prompt, now).run();
        return Response.json({ ok: true });
      }

      // 4) Verified → refresh
      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, rawFrom).run();

      // 5) Department & ticket logic
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

      // 6) Normal handling
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

    // ... your existing API endpoints unchanged ...

    return new Response("Not found", { status: 404 });
  }
};

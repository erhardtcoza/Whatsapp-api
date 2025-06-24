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

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }
    if (url.pathname === "/webhook" && request.method === "GET") {
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from = msgObj.from;
      const now = Date.now();
      let userInput = "";
      if (msgObj.type === "text") userInput = msgObj.text.body.trim();

      // 1) Lookup session
      const sess = await env.DB.prepare(
        `SELECT verified, last_seen, department FROM sessions WHERE phone = ?`
      ).bind(from).first();

      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      const expired = !sess || sess.verified === 0 || sess.last_seen + ninetyDays <= now;

      // 2) Handle authentication
      if (expired) {
        // a) If we already prompted and they replied in the form "<ID> <email>"
        const idEmailMatch = userInput.match(/^(\S+)\s+(\S+@\S+\.\S+)$/);
        if (sess && sess.verified === 0 && idEmailMatch) {
          const providedId = idEmailMatch[1];
          const providedEmail = idEmailMatch[2].toLowerCase();
          const customer = await getCustomerByPhone(from, env);

          if (!customer) {
            // phone not in Splynx → treat as lead
            const leadMsg = 
              "We couldn’t find your number in our system. " +
              "Please send your full name, address and email to create a lead.";
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
            // success!
            await env.DB.prepare(
              `INSERT INTO sessions (phone, email, customer_id, verified, last_seen, department)
               VALUES (?, ?, ?, 1, ?, NULL)
               ON CONFLICT(phone) DO UPDATE SET
                 email=excluded.email,
                 customer_id=excluded.customer_id,
                 verified=1,
                 last_seen=excluded.last_seen`
            ).bind(from, providedEmail, providedId, now).run();

            const menu =
              "✅ Verified! How can we help you?\n" +
              "1. Sales\n2. Accounts\n3. Support";
            await sendWhatsAppMessage(from, menu, env);
            await env.DB.prepare(
              `INSERT INTO messages (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(from, menu, now).run();
            return Response.json({ ok: true });
          } 
          // mismatch
          const retry = 
            "❌ That didn’t match our records.\n" +
            "Please reply with your Customer ID and email (e.g. 12345 you@example.com).";
          await sendWhatsAppMessage(from, retry, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'system', ?, 'outgoing')`
          ).bind(from, retry, now).run();
          return Response.json({ ok: true });
        }

        // b) First contact or expired → prompt for credentials
        await env.DB.prepare(
          `INSERT INTO sessions (phone, email, customer_id, verified, last_seen, department)
           VALUES (?, '', '', 0, ?, NULL)
           ON CONFLICT(phone) DO UPDATE SET
             verified=0,
             last_seen=excluded.last_seen`
        ).bind(from, now).run();

        const prompt =
          "Welcome! To verify your account, please reply with your Customer ID and email address " +
          "(e.g. 12345 you@example.com).";
        await sendWhatsAppMessage(from, prompt, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(from, prompt, now).run();
        return Response.json({ ok: true });
      }

      // 3) Verified session → refresh last_seen
      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, from).run();

      // 4) Department‐choice & ticket logic
      if (!sess.department && userInput) {
        let dept;
        if (userInput === "1") dept = "sales";
        else if (userInput === "2") dept = "accounts";
        else if (userInput === "3") dept = "support";

        if (dept) {
          await env.DB.prepare(
            `UPDATE sessions SET department = ?, last_seen = ? WHERE phone = ?`
          ).bind(dept, now, from).run();

          const date = new Date().toISOString().slice(0,10).replace(/-/g,"");
          const rnd = Math.floor(Math.random()*9000+1000);
          const ticket = `TKT-${date}-${rnd}`;

          await env.DB.prepare(
            `INSERT INTO chatsessions (phone, ticket, department, start_ts)
             VALUES (?, ?, ?, ?)`
          ).bind(from, ticket, dept, now).run();

          const ack =
            `✅ Your ticket: *${ticket}* (Dept: ${dept}).\n` +
            `How can we help you today?`;
          await sendWhatsAppMessage(from, ack, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'ticket', ?, 'outgoing')`
          ).bind(from, ack, now).run();
          return Response.json({ ok: true });
        }
      }

      // 5) Normal message handling below...
      let media_url = null, location_json = null;
      if (msgObj.type === "image") {
        userInput = "[Image]"; media_url = msgObj.image?.url;
      } else if (msgObj.type === "audio") {
        userInput = "[Audio]"; media_url = msgObj.audio?.url;
      } else if (msgObj.type === "document") {
        userInput = "[Document]"; media_url = msgObj.document?.url;
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

    // ...rest of your API endpoints unchanged...
    return new Response("Not found", { status: 404 });
  }
};

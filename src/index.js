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

      const rawFrom = msgObj.from;        // e.g. "2761XXXXXXX" or "+2761XXXXXXX"
      const now     = Date.now();

      // 1️⃣ Normalize phone for Splynx lookups (no leading + or 0)
      let normPhone = rawFrom.replace(/^\+|^0/, "");
      if (!normPhone.startsWith("27")) {
        // if somehow missing country code, prepend it
        normPhone = "27" + normPhone;
      }

      // 2️⃣ Capture text if message is text
      let userInput = "";
      if (msgObj.type === "text") {
        userInput = msgObj.text.body.trim();
      }

      // 3️⃣ Lookup session by raw WhatsApp number
      const sess = await env.DB.prepare(
        `SELECT email, customer_id, verified, last_seen, department
           FROM sessions WHERE phone = ?`
      ).bind(rawFrom).first();

      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      const expired    = !sess || sess.verified === 0 || (sess.last_seen + ninetyDays <= now);

      // --- Authentication flow ---
      if (expired) {
        // a) If pending and userInput matches "ID email"
        const match = userInput.match(/^(\S+)\s+(\S+@\S+\.\S+)$/);
        if (sess && sess.verified === 0 && match) {
          const providedId    = match[1];
          const providedEmail = match[2].toLowerCase();

          // **Use normalized phone** here
          const customer = await getCustomerByPhone(normPhone, env);

          if (!customer) {
            // Not in Splynx → treat as lead
            const leadMsg =
              "We couldn’t find your number in our system. " +
              "Please send your full name, address, and email to create a lead.";
            await sendWhatsAppMessage(rawFrom, leadMsg, env);
            await env.DB.prepare(
              `INSERT INTO messages 
                 (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'lead', ?, 'outgoing')`
            ).bind(rawFrom, leadMsg, now).run();
            return Response.json({ ok: true });
          }

          const realId    = customer.customer_id;
          const realEmail = (customer.email || "").toLowerCase();

          if (providedId === realId && providedEmail === realEmail) {
            // ✅ Verified: mark session
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
              `INSERT INTO messages 
                 (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(rawFrom, menu, now).run();
            return Response.json({ ok: true });
          } else {
            // ❌ Mismatch: show hint
            const hint = `Our records: ID ${realId}, email ${realEmail}.`;
            const retry =
              "❌ Didn’t match.\n" +
              `${hint}\n` +
              "Please reply exactly with your Customer ID and email.";
            await sendWhatsAppMessage(rawFrom, retry, env);
            await env.DB.prepare(
              `INSERT INTO messages 
                 (from_number, body, tag, timestamp, direction)
               VALUES (?, ?, 'system', ?, 'outgoing')`
            ).bind(rawFrom, retry, now).run();
            return Response.json({ ok: true });
          }
        }

        // b) New or expired: prompt for credentials
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
          `INSERT INTO messages 
             (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'system', ?, 'outgoing')`
        ).bind(rawFrom, prompt, now).run();
        return Response.json({ ok: true });
      }

      // --- Verified session: refresh last_seen ---
      await env.DB.prepare(
        `UPDATE sessions SET last_seen = ? WHERE phone = ?`
      ).bind(now, rawFrom).run();

      // --- Department & ticket creation ---
      if (!sess.department && userInput) {
        let dept;
        if (userInput === "1") dept = "sales";
        else if (userInput === "2") dept = "accounts";
        else if (userInput === "3") dept = "support";

        if (dept) {
          await env.DB.prepare(
            `UPDATE sessions SET department = ?, last_seen = ? WHERE phone = ?`
          ).bind(dept, now, rawFrom).run();

          const date = new Date().toISOString().slice(0,10).replace(/-/g,"");
          const rnd  = Math.floor(Math.random()*9000+1000);
          const ticket = `TKT-${date}-${rnd}`;

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

      // --- Normal message handling ---
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

      // Use normalized phone for customer lookup if needed
      const customer = await getCustomerByPhone(normPhone, env);
      const reply   = await routeCommand({ userInput, customer, env });
      await sendWhatsAppMessage(rawFrom, reply, env);

      // Log incoming
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

      // Ensure customers table
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(rawFrom).run();

      // Log outgoing
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(rawFrom, reply, customer ? "customer" : "lead", now, "outgoing").run();

      return Response.json({ ok: true });
    }

    // --- API and static endpoints unchanged below ---
    // ...
    return new Response("Not found", { status: 404 });
  }
};

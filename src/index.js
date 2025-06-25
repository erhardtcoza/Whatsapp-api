// src/index.js

// import { getCustomerByPhone } from './splynx.js';  // ← Splynx lookup temporarily disabled
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

const GREETINGS = ["hi","hello","hey","good day"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Handle CORS preflight ---
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return withCORS(new Response("OK", { status: 200 }));
    }

    // --- WhatsApp webhook verification (GET) ---
    if (url.pathname === "/webhook" && request.method === "GET") {
      const verify_token = url.searchParams.get("hub.verify_token");
      const challenge     = url.searchParams.get("hub.challenge");
      if (verify_token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from         = msgObj.from;
      const now          = Date.now();
      let userInput      = "";
      let media_url      = null;
      let location_json  = null;

      // Normalize incoming content
      switch (msgObj.type) {
        case "text":
          userInput = msgObj.text.body.trim();
          break;
        case "image":
          userInput = "[Image]";
          media_url = msgObj.image?.url || null;
          break;
        case "audio":
          userInput = msgObj.audio?.voice ? "[Voice Note]" : "[Audio]";
          media_url = msgObj.audio?.url || null;
          break;
        case "document":
          userInput = "[Document]";
          media_url = msgObj.document?.url || null;
          break;
        case "location":
          userInput     = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
          location_json = JSON.stringify(msgObj.location);
          break;
        default:
          userInput = `[Unknown: ${msgObj.type}]`;
          media_url = msgObj[msgObj.type]?.url || null;
      }

      // === CUSTOMER LOOKUP (temporarily disabled) ===
      // let customer = await getCustomerByPhone(from, env);
      let customer = null; // stub

      // === VERIFIED CUSTOMER FLOW ===
      if (customer && customer.verified === 1) {
        const lc = userInput.toLowerCase();

        // 1) Greeting
        if (GREETINGS.includes(lc)) {
          const reply =
            `Hello ${customer.name}! How can we help you today?\n` +
            `1. Support\n2. Sales\n3. Accounts`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'system', ?, 'outgoing')`
          ).bind(from, reply, now).run();
          return Response.json({ ok: true });
        }

        // 2) Department selection
        let dept = null;
        if (lc === "1" || lc === "support")  dept = "support";
        if (lc === "2" || lc === "sales")    dept = "sales";
        if (lc === "3" || lc === "accounts") dept = "accounts";

        if (dept) {
          await env.DB.prepare(
            `UPDATE messages SET tag=? WHERE from_number=?`
          ).bind(dept, from).run();

          const reply = `✅ You’re now in *${dept}*. How can we assist you further?`;
          await sendWhatsAppMessage(from, reply, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, 'outgoing')`
          ).bind(from, reply, dept, now).run();
          return Response.json({ ok: true });
        }

        // 3) Delegate to existing command router
        const reply = await routeCommand({ userInput, customer, env });
        await sendWhatsAppMessage(from, reply, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json)
           VALUES (?, ?, ?, ?, 'incoming', ?, ?)`
        ).bind(from, userInput, "customer", now, media_url, location_json).run();
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, ?, ?, 'outgoing')`
        ).bind(from, reply, "customer", now).run();
        return Response.json({ ok: true });
      }

      // === UNVERIFIED / NEW CLIENT FLOW ===

      // ensure record exists
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();

      // greet if first message
      if (GREETINGS.includes(userInput.toLowerCase())) {
        const prompt =
          "Welcome! Are you an existing Vinet client? If yes, reply with " +
          "`First Last, you@example.com, YourCustomerID`.\n" +
          "If not, reply with `new`, and we’ll treat you as a lead.";
        await sendWhatsAppMessage(from, prompt, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'unverified', ?, 'outgoing')`
        ).bind(from, prompt, now).run();
        return Response.json({ ok: true });
      }

      // if they reply "new", treat as lead
      if (userInput.toLowerCase() === "new") {
        const leadPrompt =
          "Great! Please send your *Name, Address, Email* and let us know " +
          "how we can help. Our sales team will get back to you.";
        await sendWhatsAppMessage(from, leadPrompt, env);
        await env.DB.prepare(
          `INSERT INTO messages (from_number, body, tag, timestamp, direction)
           VALUES (?, ?, 'leads', ?, 'outgoing')`
        ).bind(from, leadPrompt, now).run();
        await env.DB.prepare(
          `UPDATE messages SET tag='leads' WHERE from_number=?`
        ).bind(from).run();
        return Response.json({ ok: true });
      }

      // if they provide 3 comma-separated values, capture for verification
      if (userInput.includes(",")) {
        const parts = userInput.split(",").map(s => s.trim());
        if (parts.length >= 3) {
          const [name, email, customer_id] = parts;
          await env.DB.prepare(
            `UPDATE customers
               SET name=?, email=?, customer_id=?, verified=0
             WHERE phone=?`
          ).bind(name, email, customer_id, from).run();

          const thanks =
            "Thanks! Your details are recorded. An admin will verify your account shortly.";
          await sendWhatsAppMessage(from, thanks, env);
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, 'unverified', ?, 'outgoing')`
          ).bind(from, thanks, now).run();
          return Response.json({ ok: true });
        }
      }

      // fallback instruction
      const fallback =
        "I didn’t understand. Please reply with either:\n" +
        "- `new` to register as a lead\n" +
        "- or `First Last, you@example.com, YourCustomerID` if you’re an existing client.";
      await sendWhatsAppMessage(from, fallback, env);
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'unverified', ?, 'outgoing')`
      ).bind(from, fallback, now).run();
      return Response.json({ ok: true });
    }

    // ────────────────────────────────────────────────────────────────────
    // ─── All your existing `/api/...` dashboard & admin endpoints below ───
    // ────────────────────────────────────────────────────────────────────

    // --- List open chats ---
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name,
          c.email,
          c.customer_id,
          MAX(m.timestamp) as last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number=m.from_number
             ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
          SUM(CASE WHEN m.direction='incoming'
                   AND (m.seen IS NULL OR m.seen=0) THEN 1 ELSE 0 END)
            AS unread_count,
          (SELECT tag FROM messages m3
             WHERE m3.from_number=m.from_number
             ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- List closed chats ---
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name,
          c.email,
          c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number=m.from_number
             ORDER BY m2.timestamp DESC LIMIT 1) as last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.closed=1
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- List messages in a chat ---
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Close chat ---
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET closed=1 WHERE from_number=?`).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Send admin reply ---
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(phone, body, "outgoing", ts, "outgoing").run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Set chat/message tag ---
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(`UPDATE messages SET tag=? WHERE from_number=?`).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Update customer details ---
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

    // --- Auto-Replies endpoints ---
    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag || !reply) return new Response("Missing fields", { status: 400 });
      if (id) {
        await env.DB.prepare(`UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?`)
          .bind(tag, hours, reply, id).run();
      } else {
        await env.DB.prepare(`INSERT INTO auto_replies (tag, hours, reply) VALUES (?, ?, ?)`)
          .bind(tag, hours, reply).run();
      }
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status: 400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Support, Accounts, Sales dashboards ---
    if (url.pathname === "/api/support-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='support' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/accounts-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='accounts' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/sales-chats" && request.method === "GET") {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
               MAX(m.timestamp) AS last_ts,
               (SELECT body FROM messages m2 
                  WHERE m2.from_number=m.from_number
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='sales' AND (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- Unlinked / Unverified clients ---
    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT m.from_number,
               MAX(m.timestamp) AS last_msg,
               COALESCE(c.name,'') AS name,
               COALESCE(c.email,'') AS email
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0 OR c.customer_id='' OR c.customer_id IS NULL)
        GROUP BY m.from_number
        ORDER BY last_msg DESC
        LIMIT 200
      `;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch (e) {
        return withCORS(new Response("DB error", { status: 500 }));
      }
    }

    // --- Sync customers from messages ---
    if (url.pathname === "/api/customers-sync" && request.method === "POST") {
      const sql = `
        INSERT OR IGNORE INTO customers (phone, name, email, verified)
        SELECT DISTINCT from_number,'','',0
        FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `;
      await env.DB.prepare(sql).run();
      return withCORS(Response.json({ ok: true, message: "Customers synced." }));
    }

    // --- Admin users ---
    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, username, role FROM admins ORDER BY username`
      ).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username, password, role } = await request.json();
      if (!username||!password||!role) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        `INSERT INTO admins (username,password,role) VALUES(?,?,?)`
      ).bind(username,password,role).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing user id", { status: 400 }));
      await env.DB.prepare(`DELETE FROM admins WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Office hours ---
    if (url.pathname === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_hours`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/office-hours" && request.method === "POST") {
      const { tag, day, open_time, close_time, closed } = await request.json();
      if (typeof tag!=="string"||typeof day!=="number") {
        return withCORS(new Response("Missing fields", { status:400 }));
      }
      await env.DB.prepare(
        `INSERT INTO office_hours (tag,day,open_time,close_time,closed)
         VALUES(?,?,?,?,?)
         ON CONFLICT(tag,day) DO UPDATE SET
           open_time=excluded.open_time,
           close_time=excluded.close_time,
           closed=excluded.closed`
      ).bind(tag,day,open_time,close_time,closed?1:0).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Global office open/closed ---
    if (url.pathname === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM office_global LIMIT 1`).all();
      return withCORS(Response.json(results[0]||{ closed:0,message:"" }));
    }
    if (url.pathname === "/api/office-global" && request.method === "POST") {
      const { closed, message } = await request.json();
      await env.DB.prepare(
        `UPDATE office_global SET closed=?,message=? WHERE id=1`
      ).bind(closed?1:0, message||"").run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Public holidays ---
    if (url.pathname === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM public_holidays ORDER BY date`).all();
      return withCORS(Response.json(results));
    }
    if (url.pathname === "/api/public-holidays" && request.method === "POST") {
      const { date, name } = await request.json();
      await env.DB.prepare(`INSERT INTO public_holidays(date,name) VALUES(?,?)`).bind(date,name).run();
      return withCORS(Response.json({ ok: true }));
    }
    if (url.pathname === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM public_holidays WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Serve static dashboard assets ---
    if ((url.pathname === "/" || url.pathname === "/index.html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
    }

    return new Response("Not found", { status: 404 });
  }
};

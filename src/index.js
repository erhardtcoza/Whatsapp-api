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
      if (verify_token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- WhatsApp webhook handler (POST) ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok: true });

      const from         = msgObj.from;
      const type         = msgObj.type;
      let   userInput    = "";
      let   media_url    = null;
      let   location_json = null;

      // figure out incoming content
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        // special-case voice note
        if (msgObj.audio?.voice) {
          const autoReply = "Sorry, but we cannot receive or process voice notes. Please send text or documents.";
          await sendWhatsAppMessage(from, autoReply, env);
          const now = Date.now();
          // log incoming voice note
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            from,
            "[Voice Note]",
            "lead",
            now,
            "incoming",
            msgObj.audio.url
          ).run();
          // log our auto-reply
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(
            from,
            autoReply,
            "lead",
            now,
            "outgoing"
          ).run();
          // ensure we have them in customers
          await env.DB.prepare(
            `INSERT OR IGNORE INTO customers (phone, name, email, verified)
             VALUES (?, '', '', 0)`
          ).bind(from).run();
          return Response.json({ ok: true });
        } else {
          userInput = "[Audio]";
          media_url = msgObj.audio?.url || null;
        }
      } else if (type === "document") {
        userInput = "[Document]";
        media_url = msgObj.document?.url || null;
      } else if (type === "location") {
        userInput     = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        location_json = JSON.stringify(msgObj.location);
      } else {
        // catch-all
        userInput = `[Unknown: ${type}]`;
        if (msgObj[type]?.url) media_url = msgObj[type].url;
      }

      // route through your command logic
      let customer = await getCustomerByPhone(from, env);
      let reply    = await routeCommand({ userInput, customer, env });

      // send it
      await sendWhatsAppMessage(from, reply, env);

      // store incoming
      const now = Date.now();
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

      // ensure we have them in customers
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();

      // store outgoing
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        from,
        reply,
        customer ? "customer" : "lead",
        now,
        "outgoing"
      ).run();

      return Response.json({ ok: true });
    }

    //
    // ─── DASHBOARD API ROUTES ──────────────────────────────────────────────────
    //

    // OPEN CHATS
    if (url.pathname === "/api/chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name, c.email, c.customer_id,
          MAX(m.timestamp) AS last_ts,
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

    // CLOSED CHATS
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          c.name, c.email, c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2
             WHERE m2.from_number=m.from_number
             ORDER BY m2.timestamp DESC LIMIT 1) AS last_message
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

    // MESSAGES FOR A CHAT
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

    // CLOSE CHAT
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET closed=1 WHERE from_number=?`
      ).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    // SEND ADMIN MESSAGE
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body)
        return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(phone, body, "outgoing", now, "outgoing").run();
      return withCORS(Response.json({ ok: true }));
    }

    // SET TAG
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag)
        return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET tag=? WHERE from_number=?`
      ).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // UPDATE CUSTOMER DETAILS
    if (url.pathname === "/api/update-customer" && request.method === "POST") {
      const { phone, name, customer_id, email } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(`
        INSERT INTO customers
           (phone, name, customer_id, email, verified)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          name=excluded.name,
          customer_id=excluded.customer_id,
          email=excluded.email,
          verified=1
      `).bind(phone, name, customer_id, email).run();
      return withCORS(Response.json({ ok: true }));
    }

    //
    // ─── AUTO-REPLIES ──────────────────────────────────────────────────────────
    //

    // fetch all
    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM auto_replies ORDER BY tag, hours`
      ).all();
      return withCORS(Response.json(results));
    }

    // add or update
    if (url.pathname === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag || !reply) return new Response("Missing fields", { status: 400 });
      if (id) {
        await env.DB.prepare(
          `UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?`
        ).bind(tag, hours, reply, id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO auto_replies (tag, hours, reply) VALUES (?, ?, ?)`
        ).bind(tag, hours, reply).run();
      }
      return withCORS(Response.json({ ok: true }));
    }

    // delete one
    if (
      url.pathname === "/api/auto-reply-delete" &&
      request.method === "POST"
    ) {
      const { id } = await request.json();
      if (!id) return new Response("Missing id", { status: 400 });
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    //
    // ─── SUPPORT / ACCOUNTS / SALES CHATS ──────────────────────────────────────
    //

    if (url.pathname === "/api/support-chats" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number, c.name, c.email, c.customer_id,
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
        SELECT
          m.from_number, c.name, c.email, c.customer_id,
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
        SELECT
          m.from_number, c.name, c.email, c.customer_id,
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

    //
    // ─── UNLINKED CLIENTS ───────────────────────────────────────────────────────
    //

    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          MAX(m.timestamp) AS last_msg,
          COALESCE(c.name, '') AS name,
          COALESCE(c.email, '') AS email
        FROM messages m
        LEFT JOIN customers c ON m.from_number=c.phone
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0 OR c.customer_id IS NULL OR c.customer_id='')
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

    // ——————————————————————————————————————————————————————————
    //             ADMIN USER MANAGEMENT (admins table)
    // ——————————————————————————————————————————————————————————

    // list all admins
    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, username, role FROM admins ORDER BY username"
      ).all();
      return withCORS(Response.json(results));
    }

    // add a new admin
    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username, password, role } = await request.json();
      if (!username || !password || !role) {
        return withCORS(new Response("Missing fields", { status: 400 }));
      }
      await env.DB.prepare(
        `INSERT INTO admins (username, password, role)
         VALUES (?, ?, ?)`
      ).bind(username, password, role).run();
      return withCORS(Response.json({ ok: true }));
    }

    // delete an admin
    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) {
        return withCORS(new Response("Missing user id", { status: 400 }));
      }
      await env.DB.prepare(
        "DELETE FROM admins WHERE id=?"
      ).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    //
    // ─── OFFICE HOURS ───────────────────────────────────────────────────────────
    //

    // fetch all office-hours rows
    if (url.pathname === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM office_hours").all();
      return withCORS(Response.json(results));
    }

    // upsert one office-hours row
    if (url.pathname === "/api/office-hours" && request.method === "POST") {
      const { tag, day, open_time, close_time, closed } = await request.json();
      if (typeof tag !== "string" || typeof day !== "number") {
        return withCORS(new Response("Missing fields", { status: 400 }));
      }
      await env.DB.prepare(
        `INSERT INTO office_hours (tag, day, open_time, close_time, closed)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tag, day) DO UPDATE SET
           open_time=excluded.open_time,
           close_time=excluded.close_time,
           closed=excluded.closed`
      ).bind(tag, day, open_time, close_time, closed ? 1 : 0).run();
      return withCORS(Response.json({ ok: true }));
    }

    // fetch global status
    if (url.pathname === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM office_global LIMIT 1").all();
      return withCORS(Response.json(results?.[0] || { closed: 0, message: "" }));
    }

    // set global status
    if (url.pathname === "/api/office-global" && request.method === "POST") {
      const { closed, message } = await request.json();
      await env.DB.prepare(
        `UPDATE office_global
           SET closed=?, message=? WHERE id=1`
      ).bind(closed ? 1 : 0, message || "").run();
      return withCORS(Response.json({ ok: true }));
    }

    //
    // ─── PUBLIC HOLIDAYS ────────────────────────────────────────────────────────
    //

    // list
    if (url.pathname === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM public_holidays ORDER BY date"
      ).all();
      return withCORS(Response.json(results));
    }

    // add
    if (url.pathname === "/api/public-holidays" && request.method === "POST") {
      const { date, name } = await request.json();
      await env.DB.prepare(
        "INSERT INTO public_holidays (date, name) VALUES (?, ?)"
      ).bind(date, name).run();
      return withCORS(Response.json({ ok: true }));
    }

    // delete
    if (url.pathname === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(
        "DELETE FROM public_holidays WHERE id=?"
      ).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    //
    // ─── STATIC ASSETS ─────────────────────────────────────────────────────────
    //

    if ((url.pathname === "/" || url.pathname === "/index.html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(url.origin + "/index.html"));
    }

    // fallback
    return new Response("Not found", { status: 404 });
  }
};

import { getCustomerByPhone } from './splynx.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand } from './commands.js';

// --- CORS helper ---
function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Cookie");
  return resp;
}

// --- Cookie parser ---
function parseCookies(header = "") {
  return header.split(';').map(s => s.trim()).reduce((acc, pair) => {
    const [k, ...v] = pair.split('=');
    if (!k) return acc;
    acc[k] = decodeURIComponent(v.join('='));
    return acc;
  }, {});
}

// --- Auth guard: checks session cookie in KV ---
async function requireAuth(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || "");
  const sid = cookies.session;
  if (!sid) return null;
  const session = await env.SESSIONS.get(sid, { type: 'json' });
  return session; // { username, role } or null
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
      const challenge    = url.searchParams.get("hub.challenge");
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

      const from = msgObj.from;
      const type = msgObj.type;
      let userInput    = "";
      let media_url    = null;
      let location_json= null;

      // --- Parse incoming message ---
      if (type === "text") {
        userInput = msgObj.text.body.trim();
      } else if (type === "image") {
        userInput = "[Image]";
        media_url = msgObj.image?.url || null;
      } else if (type === "audio") {
        if (msgObj.audio?.voice) {
          const autoReply = "Sorry, but we cannot receive or process voice notes. Please send text or documents.";
          await sendWhatsAppMessage(from, autoReply, env);
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(from, "[Voice Note]", "lead", now, "incoming", msgObj.audio?.url || null).run();
          await env.DB.prepare(
            `INSERT INTO messages (from_number, body, tag, timestamp, direction)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(from, autoReply, "lead", now, "outgoing").run();
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
        userInput = `[Unknown: ${type}]`;
        if (msgObj[type]?.url) media_url = msgObj[type].url;
      }

      // --- Business logic ---
      let customer = await getCustomerByPhone(from, env);
      let reply    = await routeCommand({ userInput, customer, env });
      await sendWhatsAppMessage(from, reply, env);

      const now = Date.now();
      // Store incoming
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

      // Ensure customer record exists
      await env.DB.prepare(
        `INSERT OR IGNORE INTO customers (phone, name, email, verified)
         VALUES (?, '', '', 0)`
      ).bind(from).run();

      // Store outgoing
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

    // --- Public: login ---
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();
      if (!username || !password) {
        return withCORS(new Response("Missing credentials", { status: 400 }));
      }
      // Check admins table
      const admin = await env.DB.prepare(
        `SELECT id, username, role FROM admins
           WHERE username = ? AND password = ?`
      ).bind(username, password).first();
      if (!admin) {
        return withCORS(new Response("Invalid username or password", { status: 401 }));
      }
      // Create session
      const sid = crypto.randomUUID();
      await env.SESSIONS.put(
        sid,
        JSON.stringify({ username: admin.username, role: admin.role }),
        { expirationTtl: 3600 }
      );
      const resp = withCORS(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
      resp.headers.set(
        "Set-Cookie",
        `session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`
      );
      return resp;
    }

    // --- Public: logout ---
    if (url.pathname === "/api/logout" && request.method === "POST") {
      const cookies = parseCookies(request.headers.get("Cookie"));
      const sid     = cookies.session;
      if (sid) await env.SESSIONS.delete(sid);
      const resp = withCORS(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
      resp.headers.set(
        "Set-Cookie",
        `session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
      );
      return resp;
    }

    // --- Protect all other /api routes ---
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/login" && url.pathname !== "/api/logout") {
        const session = await requireAuth(request, env);
        if (!session) {
          return withCORS(new Response("Unauthorized", { status: 401 }));
        }
      }
    }

    // --- Your existing API endpoints below ---

    // /api/chats (open)
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

    // /api/closed-chats
    if (url.pathname === "/api/closed-chats" && request.method === "GET") {
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
        WHERE m.closed=1
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50
      `;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // /api/messages
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      const sql = `
        SELECT id, from_number, body, tag, timestamp,
               direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200
      `;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // /api/close-chat
    if (url.pathname === "/api/close-chat" && request.method === "POST") {
      const { phone } = await request.json();
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET closed=1 WHERE from_number=?`
      ).bind(phone).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/send-message
    if (url.pathname === "/api/send-message" && request.method === "POST") {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response("Missing fields", { status: 400 }));
      await sendWhatsAppMessage(phone, body, env);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction, seen)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(phone, body, "outgoing", now, "outgoing").run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/set-tag
    if (url.pathname === "/api/set-tag" && request.method === "POST") {
      const { from_number, tag } = await request.json();
      if (!from_number || !tag) return withCORS(new Response("Missing fields", { status: 400 }));
      await env.DB.prepare(
        `UPDATE messages SET tag=? WHERE from_number=?`
      ).bind(tag, from_number).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/update-customer
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

    // /api/auto-replies
    if (url.pathname === "/api/auto-replies" && request.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT * FROM auto_replies`).all();
      return withCORS(Response.json(results));
    }
    // /api/auto-reply (add/update)
    if (url.pathname === "/api/auto-reply" && request.method === "POST") {
      const { id, tag, hours, reply } = await request.json();
      if (!tag || !reply) return withCORS(new Response("Missing fields", { status: 400 }));
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
    // /api/auto-reply-delete
    if (url.pathname === "/api/auto-reply-delete" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) return withCORS(new Response("Missing id", { status: 400 }));
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/support-chats
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

    // /api/accounts-chats
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

    // /api/sales-chats
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

    // /api/unlinked-clients
    if (url.pathname === "/api/unlinked-clients" && request.method === "GET") {
      const sql = `
        SELECT
          m.from_number,
          MAX(m.timestamp) AS last_msg,
          COALESCE(c.name,'')  AS name,
          COALESCE(c.email,'') AS email
        FROM messages m
        LEFT JOIN customers c ON m.from_number=c.phone
        WHERE m.tag='unverified'
          AND (c.verified IS NULL OR c.verified=0
               OR c.customer_id IS NULL OR c.customer_id='')
        GROUP BY m.from_number
        ORDER BY last_msg DESC
        LIMIT 200
      `;
      try {
        const { results } = await env.DB.prepare(sql).all();
        return withCORS(Response.json(results));
      } catch {
        return withCORS(new Response("DB error", { status: 500 }));
      }
    }

    // /api/customers-sync
    if (url.pathname === "/api/customers-sync" && request.method === "POST") {
      const sql = `
        INSERT OR IGNORE INTO customers
          (phone, name, email, verified)
        SELECT DISTINCT from_number, '', '', 0
        FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `;
      await env.DB.prepare(sql).run();
      return withCORS(Response.json({
        ok: true,
        message: "Customers table synced with messages."
      }));
    }

    // /api/users
    if (url.pathname === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, username, role FROM admins ORDER BY username"
      ).all();
      return withCORS(Response.json(results));
    }

    // /api/add-user
    if (url.pathname === "/api/add-user" && request.method === "POST") {
      const { username, password, role } = await request.json();
      if (!username || !password || !role) {
        return withCORS(new Response("Missing fields", { status: 400 }));
      }
      await env.DB.prepare(
        "INSERT INTO admins (username, password, role) VALUES (?, ?, ?)"
      ).bind(username, password, role).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/delete-user
    if (url.pathname === "/api/delete-user" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) {
        return withCORS(new Response("Missing user id", { status: 400 }));
      }
      await env.DB.prepare("DELETE FROM admins WHERE id=?").bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/office-hours (GET)
    if (url.pathname === "/api/office-hours" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM office_hours"
      ).all();
      return withCORS(Response.json(results));
    }

    // /api/office-hours (POST)
    if (url.pathname === "/api/office-hours" && request.method === "POST") {
      const { tag, day, open_time, close_time, closed } = await request.json();
      if (typeof tag !== "string" || typeof day !== "number") {
        return withCORS(new Response("Missing fields", { status: 400 }));
      }
      await env.DB.prepare(
        `INSERT INTO office_hours
           (tag, day, open_time, close_time, closed)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tag, day) DO UPDATE SET
           open_time=excluded.open_time,
           close_time=excluded.close_time,
           closed=excluded.closed`
      ).bind(tag, day, open_time, close_time, closed ? 1 : 0).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/office-global (GET)
    if (url.pathname === "/api/office-global" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM office_global LIMIT 1"
      ).all();
      return withCORS(Response.json(results?.[0] || {
        closed: 0,
        message: ""
      }));
    }

    // /api/office-global (POST)
    if (url.pathname === "/api/office-global" && request.method === "POST") {
      const { closed, message } = await request.json();
      await env.DB.prepare(
        "UPDATE office_global SET closed=?, message=? WHERE id=1"
      ).bind(closed ? 1 : 0, message || "").run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/public-holidays (GET)
    if (url.pathname === "/api/public-holidays" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM public_holidays ORDER BY date"
      ).all();
      return withCORS(Response.json(results));
    }

    // /api/public-holidays (POST)
    if (url.pathname === "/api/public-holidays" && request.method === "POST") {
      const { date, name } = await request.json();
      await env.DB.prepare(
        "INSERT INTO public_holidays (date, name) VALUES (?, ?)"
      ).bind(date, name).run();
      return withCORS(Response.json({ ok: true }));
    }

    // /api/public-holidays/delete
    if (url.pathname === "/api/public-holidays/delete" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(
        "DELETE FROM public_holidays WHERE id=?"
      ).bind(id).run();
      return withCORS(Response.json({ ok: true }));
    }

    // --- Serve static HTML dashboard ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
      }
      return new Response("Dashboard static assets missing", { status: 404 });
    }

    // --- Fallback ---
    return new Response("Not found", { status: 404 });
  }
};

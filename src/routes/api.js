import { withCORS } from '../utils/cors.js';

export default async function apiHandler(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCORS(new Response("OK"));
  }

  switch (url.pathname) {
    // --- API: List open chats ---
    case "/api/chats": {
      const sql = `
        SELECT m.from_number, c.name, c.email, c.customer_id,
          MAX(m.timestamp) AS last_ts,
          (SELECT body FROM messages m2
           WHERE m2.from_number=m.from_number
           ORDER BY m2.timestamp DESC LIMIT 1) AS last_message,
          SUM(CASE WHEN m.direction='incoming'
            AND (m.seen IS NULL OR m.seen=0) THEN 1 ELSE 0 END) AS unread_count,
          (SELECT tag FROM messages m3
           WHERE m3.from_number=m.from_number
           ORDER BY m3.timestamp DESC LIMIT 1) AS tag
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        WHERE (m.closed IS NULL OR m.closed=0)
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50`;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- API: List messages for a chat ---
    case "/api/messages": {
      const phone = url.searchParams.get("phone");
      if (!phone) return withCORS(new Response("Missing phone", { status: 400 }));

      const { results } = await env.DB.prepare(`
        SELECT id, from_number, body, tag, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200
      `).bind(phone).all();

      return withCORS(Response.json(results));
    }

    // --- API: Close chat ---
    case "/api/close-chat": {
      if (request.method !== "POST") break;

      const { phone } = await request.json();
      await env.DB.prepare(`
        UPDATE messages SET closed=1 WHERE from_number=?
      `).bind(phone).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: List leads ---
    case "/api/leads": {
      const { results } = await env.DB.prepare(`
        SELECT * FROM leads ORDER BY created_at DESC LIMIT 200
      `).all();

      return withCORS(Response.json(results));
    }

    // --- API: Mark lead contacted ---
    case "/api/lead-contacted": {
      if (request.method !== "POST") break;

      const { id } = await request.json();
      await env.DB.prepare(`
        UPDATE leads SET status='contacted' WHERE id=?
      `).bind(id).run();

      return withCORS(Response.json({ ok: true }));
    }

    // --- API: Unlinked clients ---
    case "/api/unlinked-clients": {
      const { results } = await env.DB.prepare(`
        SELECT phone, name, email, customer_id, verified
        FROM customers
        WHERE verified=0
        ORDER BY phone DESC
        LIMIT 200
      `).all();

      return withCORS(Response.json(results));
    }

    // --- API: Sync customers from messages ---
    case "/api/customers-sync": {
      if (request.method !== "POST") break;

      await env.DB.prepare(`
        INSERT OR IGNORE INTO customers (phone, name, email, verified)
        SELECT DISTINCT from_number, '', '', 0
        FROM messages
        WHERE from_number NOT IN (SELECT phone FROM customers)
      `).run();

      return withCORS(Response.json({ ok: true, message: "Synced." }));
    }

    // --- API: Chat sessions for a customer ---
    case "/api/chat-sessions": {
      const phone = url.searchParams.get("phone");
      const { results } = await env.DB.prepare(`
        SELECT id, ticket, department, start_ts, end_ts
        FROM chatsessions WHERE phone=? ORDER BY start_ts DESC
      `).bind(phone).all();

      return withCORS(Response.json(results));
    }

    // --- API: Auto-Replies CRUD ---
    case "/api/auto-replies": {
      const { results } = await env.DB.prepare(`
        SELECT * FROM auto_replies
      `).all();

      return withCORS(Response.json(results));
    }

    case "/api/auto-reply": {
      if (request.method !== "POST") break;

      const { id, tag, hours, reply } = await request.json();
      if (id) {
        await env.DB.prepare(`
          UPDATE auto_replies SET tag=?, hours=?, reply=? WHERE id=?
        `).bind(tag, hours, reply, id).run();
      } else {
        await env.DB.prepare(`
          INSERT INTO auto_replies (tag, hours, reply) VALUES (?, ?, ?)
        `).bind(tag, hours, reply).run();
      }

      return withCORS(Response.json({ ok: true }));
    }

    case "/api/auto-reply-delete": {
      if (request.method !== "POST") break;

      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM auto_replies WHERE id=?`).bind(id).run();

      return withCORS(Response.json({ ok: true }));
    }

    default:
      return new Response("Not Found", { status: 404 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}


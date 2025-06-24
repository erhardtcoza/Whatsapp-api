import { sendWhatsAppMessage } from './whatsapp.js';
import { routeCommand }        from './commands.js';

// CORS helper
function withCORS(resp) {
  resp.headers.set('Access-Control-Allow-Origin','*');
  resp.headers.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers','*');
  return resp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return withCORS(new Response('OK', { status:200 }));
    }

    // --- WhatsApp webhook (POST) ---
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const payload = await request.json();
      const msgObj  = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msgObj) return Response.json({ ok:true });

      const from = msgObj.from;
      const now  = Date.now();

      // 1) Ensure session exists (or update last_seen)
      await env.DB.prepare(
        `INSERT INTO sessions
           (phone, verified, last_seen)
         VALUES (?, 0, ?)
         ON CONFLICT(phone) DO UPDATE SET
           last_seen=excluded.last_seen`
      ).bind(from, now).run();

      // 2) Extract userInput + media/location
      let userInput = '';
      let media_url = null;
      let loc_json  = null;

      if (msgObj.type === 'text') {
        userInput = msgObj.text.body.trim();
      } else if (msgObj.type === 'image') {
        userInput = '[Image]';
        media_url = msgObj.image?.url || null;
      } else if (msgObj.type === 'location') {
        userInput = `[LOCATION: ${msgObj.location.latitude},${msgObj.location.longitude}]`;
        loc_json = JSON.stringify(msgObj.location);
      } else {
        userInput = `[${msgObj.type.toUpperCase()}]`;
        media_url = msgObj[msgObj.type]?.url || null;
      }

      // 3) Business logic (your existing router)
      const reply = await routeCommand({ userInput, env });

      // 4) Send the reply
      await sendWhatsAppMessage(from, reply, env);

      // 5) Log incoming
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, timestamp, direction, media_url, location_json)
         VALUES (?, ?, ?, 'incoming', ?, ?)`
      ).bind(from, userInput, now, media_url, loc_json).run();

      // 6) Log outgoing
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'outgoing', ?, 'outgoing')`
      ).bind(from, reply, now).run();

      return Response.json({ ok:true });
    }

    // --- Fetch chats for dashboard ---
    if (url.pathname === '/api/chats' && request.method === 'GET') {
      const sql = `
        SELECT
          m.from_number,
          c.customer_id,
          c.name,
          MAX(m.timestamp) AS last_ts,
          SUM(CASE WHEN m.direction='incoming' AND (m.seen IS NULL OR m.seen=0) THEN 1 ELSE 0 END) AS unread
        FROM messages m
        LEFT JOIN customers c ON c.phone=m.from_number
        GROUP BY m.from_number
        ORDER BY last_ts DESC
        LIMIT 50`;
      const { results } = await env.DB.prepare(sql).all();
      return withCORS(Response.json(results));
    }

    // --- List messages ---
    if (url.pathname === '/api/messages' && request.method === 'GET') {
      const phone = url.searchParams.get('phone');
      if (!phone) return withCORS(new Response('Missing phone', { status:400 }));
      const sql = `
        SELECT id, from_number, body, timestamp, direction, media_url, location_json
        FROM messages
        WHERE from_number=?
        ORDER BY timestamp ASC
        LIMIT 200`;
      const { results } = await env.DB.prepare(sql).bind(phone).all();
      return withCORS(Response.json(results));
    }

    // --- Send reply from UI ---
    if (url.pathname === '/api/send-message' && request.method === 'POST') {
      const { phone, body } = await request.json();
      if (!phone || !body) return withCORS(new Response('Missing', { status:400 }));
      await sendWhatsAppMessage(phone, body, env);
      const ts = Date.now();
      await env.DB.prepare(
        `INSERT INTO messages
           (from_number, body, tag, timestamp, direction)
         VALUES (?, ?, 'outgoing', ?, 'outgoing')`
      ).bind(phone, body, ts).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Update customer details (manual form) ---
    if (url.pathname === '/api/update-customer' && request.method === 'POST') {
      const { phone, customer_id, first_name, last_name } = await request.json();
      if (!phone) return withCORS(new Response('Missing phone', { status:400 }));
      const fullName = `${first_name.trim()} ${last_name.trim()}`.trim();
      await env.DB.prepare(`
        INSERT INTO customers (phone, customer_id, name, verified)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(phone) DO UPDATE SET
          customer_id=excluded.customer_id,
          name=excluded.name,
          verified=1
      `).bind(phone, customer_id, fullName).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Close chat (archive) ---
    if (url.pathname === '/api/close-chat' && request.method === 'POST') {
      const { phone } = await request.json();
      await env.DB.prepare(
        `UPDATE messages SET closed=1 WHERE from_number=?`
      ).bind(phone).run();
      return withCORS(Response.json({ ok:true }));
    }

    // --- Static assets & fallback ---
    if (url.pathname==='/'||url.pathname==='/index.html') {
      if (env.ASSETS) return env.ASSETS.fetch(new Request(url.origin+'/index.html'));
      return new Response('Missing assets', { status:404 });
    }

    return new Response('Not found', { status:404 });
  }
};

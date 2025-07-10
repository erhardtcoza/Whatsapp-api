// db.js - Database utility functions for Cloudflare D1
export const DB = {
  async query(env, sql, params = []) {
    const stmt = env.DB.prepare(sql);
    return stmt.bind(...params).all();
  },

  async queryFirst(env, sql, params = []) {
    const stmt = env.DB.prepare(sql);
    return stmt.bind(...params).first();
  },

  async execute(env, sql, params = []) {
    const stmt = env.DB.prepare(sql);
    return stmt.bind(...params).run();
  },

  // Helper methods for common operations:
  
  async getCustomerByPhone(env, phone) {
    return this.queryFirst(env,
      `SELECT * FROM customers WHERE phone = ?`,
      [phone]
    );
  },

  async getMessagesByPhone(env, phone, limit = 200) {
    return this.query(env,
      `SELECT * FROM messages WHERE from_number=? ORDER BY timestamp DESC LIMIT ?`,
      [phone, limit]
    );
  },

  async insertMessage(env, message) {
    const {
      from_number,
      body,
      tag = 'unverified',
      timestamp = Date.now(),
      direction = 'incoming',
      media_url = null,
      location_json = null,
      closed = 0,
    } = message;

    return this.execute(env,
      `INSERT INTO messages (from_number, body, tag, timestamp, direction, media_url, location_json, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [from_number, body, tag, timestamp, direction, media_url, location_json, closed]
    );
  },

  async updateCustomerVerification(env, phone, verified = 1) {
    return this.execute(env,
      `UPDATE customers SET verified=? WHERE phone=?`,
      [verified, phone]
    );
  },

  async insertOrUpdateCustomer(env, customer) {
    const { phone, name = '', email = '', customer_id = '', verified = 0 } = customer;
    return this.execute(env,
      `INSERT INTO customers (phone, name, email, customer_id, verified)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         name=excluded.name,
         email=excluded.email,
         customer_id=excluded.customer_id,
         verified=excluded.verified`,
      [phone, name, email, customer_id, verified]
    );
  },
  
  async getOfficeHours(env, department, day) {
    return this.queryFirst(env,
      `SELECT open_time, close_time, closed FROM office_hours WHERE tag=? AND day=?`,
      [department, day]
    );
  },
  
  async insertLead(env, lead) {
    const { phone, name, email, address, status = 'new', created_at = Date.now() } = lead;
    return this.execute(env,
      `INSERT INTO leads (phone, name, email, address, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [phone, name, email, address, status, created_at]
    );
  },

  async closeChatSession(env, ticket) {
    return this.execute(env,
      `UPDATE chatsessions SET end_ts=? WHERE ticket=?`,
      [Date.now(), ticket]
    );
  },

  async createChatSession(env, phone, department, session_id) {
    return this.execute(env,
      `INSERT INTO chatsessions (phone, ticket, department, start_ts)
       VALUES (?, ?, ?, ?)`,
      [phone, session_id, department, Date.now()]
    );
  },
};

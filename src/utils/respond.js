// respond.js – Auto-reply logic for WhatsApp messages

import { isOfficeOpen } from "./office.js";

// Simple keyword-based tagging
export function classifyMessage(body = "") {
  const text = body.toLowerCase();

  if (text.includes("balance") || text.includes("pay") || text.includes("invoice")) {
    return "accounts";
  }

  if (text.includes("help") || text.includes("problem") || text.includes("support")) {
    return "support";
  }

  if (text.includes("sign up") || text.includes("fibre") || text.includes("internet") || text.includes("connect")) {
    return "sales";
  }

  return "lead";
}

// Auto-response generator
export function getAutoReply(tag, isOpen = true) {
  if (isOpen) return null;

  const replies = {
    support: "🛠️ Our support team is currently offline. We'll get back to you during office hours.",
    sales: "📈 Our sales team is currently unavailable. Expect a reply when we're back online.",
    accounts: "💳 Accounts team is offline. We'll respond during working hours.",
    lead: "Thanks for reaching out! Our team will get in touch with you soon.",
  };

  return replies[tag] || null;
}

// Entry point for incoming message classification and auto-reply
export function respondToMessage(body, now = new Date()) {
  const tag = classifyMessage(body);
  const open = isOfficeOpen(tag, now);
  const autoReply = getAutoReply(tag, open);

  return {
    tag,
    autoReply,
    officeOpen: open,
  };
}

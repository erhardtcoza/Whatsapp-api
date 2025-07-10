// office.js – Office hours and holiday check helpers

// Example default structure
const officeHours = {
  support: { start: 8, end: 17 },
  sales: { start: 9, end: 18 },
  accounts: { start: 8, end: 16 },
  lead: { start: 8, end: 18 }
};

// Simple list of public holidays (YYYY-MM-DD format)
const publicHolidays = [
  "2025-01-01", "2025-03-21", "2025-04-18", "2025-04-27",
  "2025-05-01", "2025-06-16", "2025-08-09", "2025-09-24",
  "2025-12-16", "2025-12-25", "2025-12-26"
];

export function isPublicHoliday(date = new Date()) {
  const iso = date.toISOString().slice(0, 10);
  return publicHolidays.includes(iso);
}

export function isOfficeOpen(tag = "support", now = new Date()) {
  if (isPublicHoliday(now)) return false;

  const day = now.getDay();
  if (day === 0) return false; // Sunday closed

  const hour = now.getHours();
  const { start, end } = officeHours[tag] || { start: 8, end: 17 };
  return hour >= start && hour < end;
}

export async function sendClosureMessageWithButton(env, phone, tag) {
  const msg = `Our ${tag} team is currently unavailable. You can leave a message or come back during office hours.`;
  const button = {
    type: "button",
    text: { body: msg },
    buttons: [
      {
        type: "reply",
        reply: {
          id: "office_hours_followup",
          title: "Remind Me Later"
        }
      }
    ]
  };

  await fetch(`https://graph.facebook.com/v17.0/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: button
    })
  });
}

export function getOfficeHours(tag = "support") {
  return officeHours[tag] || { start: 8, end: 17 };
}

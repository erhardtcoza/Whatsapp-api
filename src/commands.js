import { getCustomerBalance, getCustomerStatus, getLatestInvoice } from './splynx.js';

export async function routeCommand({ userInput, customer, env }) {
  // --- New Customer ---
  if (!customer) {
    if (/^hi|hello|hey\b/i.test(userInput)) {
      return `Hello! I don't have your phone number in our database. Type 'register' for setup info or reply with your name and email.`;
    }
    if (/register/i.test(userInput)) {
      return `To register, please reply with:\nFull Name\nEmail Address\nPhysical Address\nWe'll get you set up ASAP.`;
    }
    return `Sorry, your number isn't linked to a Vinet account yet. Type 'register' or 'help' for more options.`;
  }

  // --- Existing Customer ---
  const name = customer.name || "customer";
  const customerId = customer.id;

  if (/^(balance|B)\b/i.test(userInput)) {
    let bal = await getCustomerBalance(customerId);
    if (!bal) return "Couldn't fetch your balance.";
    return (
      `💰 *Account Balance*\n` +
      `💳 Outstanding: R${bal}\n` +
      (bal < 0
        ? `⚠️ Payment needed to avoid service interruption.\nType *P* for payment options.`
        : `Thank you for staying up to date!`)
    );
  }

  if (/^(service|S)\b/i.test(userInput)) {
    let status = await getCustomerStatus(customerId);
    if (!status) return "Couldn't fetch your service status.";
    let msg = `Your account status: ${status}.`;
    if (status !== "active") msg += " Please contact support for help.";
    return msg;
  }

  if (/^(invoice|I)\b/i.test(userInput)) {
    let inv = await getLatestInvoice(customerId);
    if (!inv) return "Couldn't retrieve your invoice.";
    return `Your latest invoice: #${inv.id}, Amount: R${inv.total}, Date: ${inv.date_add}.`;
  }

  if (/^P\b/i.test(userInput)) {
    return `Payment options:\n- EFT: FNB 62874851762, Branch: 200912\n- Card: https://pay.vinet.co.za\nReference: Your customer ID (${customerId})`;
  }

  if (/^U\b/i.test(userInput)) {
    return `Please log into your client portal for live usage: https://client.vinet.co.za\nOr type 'Support' for help.`;
  }

  if (/slow|no internet|not working|support/i.test(userInput)) {
    return (
      `🛠️ Technical Support\n` +
      `Hi ${name}, here are common solutions:\n` +
      `- Restart your router/modem\n- Check all cables and power\n- If your account is blocked, type *B* for balance.\n` +
      `Account ID: ${customerId}\nIf you need to log a fault, reply *fault* and our support desk will call you.`
    );
  }

  if (/^help$/i.test(userInput)) {
    return `Type:\nB - Balance\nS - Service status\nI - Latest invoice\nP - Payment options\nU - Data usage\nSupport - Technical help`;
  }

  return `Hi ${name}, I didn’t understand that. Type 'help' for options.`;
}

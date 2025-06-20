// --- Splynx API helpers ---

const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(phone, env) {
  // Ensure phone is formatted correctly for Splynx lookup
  try {
    const url = `https://splynx.vinet.co.za/api/2.0/admin/customers/customer?main_phone=${encodeURIComponent(phone)}`;
    const res = await fetch(url, {
      headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" }
    });
    const data = await res.json();
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch {
    return null;
  }
}

export async function getCustomerBalance(customerId) {
  try {
    const url = `https://splynx.vinet.co.za/api/2.0/admin/customers/customer/${customerId}/balance`;
    const res = await fetch(url, {
      headers: { Authorization: AUTH_HEADER }
    });
    const data = await res.json();
    return data?.balance ? parseFloat(data.balance).toFixed(2) : null;
  } catch {
    return null;
  }
}

export async function getCustomerStatus(customerId) {
  try {
    const url = `https://splynx.vinet.co.za/api/2.0/admin/customers/customer/${customerId}`;
    const res = await fetch(url, {
      headers: { Authorization: AUTH_HEADER }
    });
    const data = await res.json();
    return data?.status || null;
  } catch {
    return null;
  }
}

export async function getLatestInvoice(customerId) {
  try {
    const url = `https://splynx.vinet.co.za/api/2.0/admin/invoices/invoice?customer_id=${customerId}&limit=1&sort=-id`;
    const res = await fetch(url, {
      headers: { Authorization: AUTH_HEADER }
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      const inv = data[0];
      return {
        id: inv.id,
        total: parseFloat(inv.total).toFixed(2),
        date_add: inv.date_add
      };
    }
    return null;
  } catch {
    return null;
  }
}

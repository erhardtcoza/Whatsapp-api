const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(phone, env) {
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

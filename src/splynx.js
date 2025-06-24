const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

export async function getCustomerByPhone(rawPhone, env) {
  try {
    // normalize to “27123456789”
    let phone = rawPhone.replace(/^\+|^0/, "");
    if (!phone.startsWith("27")) phone = "27" + phone;

    const url = `https://splynx.vinet.co.za/api/2.0/customers/search?phone=${encodeURIComponent(phone)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json"
      }
    });
    if (!res.ok) return null;

    const json = await res.json();
    // Splynx returns { data: [ ... ] }
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length ? list[0] : null;
  } catch {
    return null;
  }
}

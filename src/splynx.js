const AUTH_HEADER =
  "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    console.log(`SPYLNX PARSE ERROR [${url}]:`, err);
  }
  console.log(`SPYLNX RESPONSE [${url}]:`, JSON.stringify(json));
  return json;
}

export async function getCustomerByPhone(rawPhone) {
  // normalize to “27XXXXXXXXXX”
  let phone = rawPhone.replace(/^\+|^0/, "");
  if (!phone.startsWith("27")) phone = "27" + phone;

  // candidate URLs
  const urls = [
    `https://splynx.vinet.co.za/api/2.0/customers/search?phone=${encodeURIComponent(phone)}`,
    `https://splynx.vinet.co.za/api/customers/search?phone=${encodeURIComponent(phone)}`,
    `https://splynx.vinet.co.za/api/2.0/admin/customers/search?phone=${encodeURIComponent(phone)}`,
    `https://splynx.vinet.co.za/api/admin/customers/search?phone=${encodeURIComponent(phone)}`,
  ];

  // try each in order
  for (const url of urls) {
    const json = await fetchJson(url);
    if (json?.data && Array.isArray(json.data) && json.data.length) {
      return json.data[0];
    }
  }

  // no matches
  return null;
}

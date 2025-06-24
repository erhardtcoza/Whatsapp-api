const AUTH_HEADER = "Basic NTcxMDRhNGJjNjhhY2Y2MjRkMDliMmYwOTQ1ZTI1M2E6N2UyOTNmY2QyNzBjODJmOTdjNWQzODUwZjdhM2I1MTE=";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    console.log(`SPYLNX PARSE ERROR for ${url}:`, e);
  }
  console.log(`SPYLNX RESPONSE [${url}]:`, JSON.stringify(json));
  return json;
}

export async function getCustomerByPhone(rawPhone, env) {
  // 1) Normalize to “27123456789”
  let phone = rawPhone.replace(/^\+|^0/, "");
  if (!phone.startsWith("27")) phone = "27" + phone;

  // 2) Primary search by phone
  const url1 = `https://splynx.vinet.co.za/api/2.0/customers/search?phone=${encodeURIComponent(phone)}`;
  const json1 = await fetchJson(url1);
  if (json1?.data && Array.isArray(json1.data) && json1.data.length) {
    return json1.data[0];
  }

  // 3) Secondary search by main_phone
  const url2 = `https://splynx.vinet.co.za/api/2.0/customers/search?main_phone=${encodeURIComponent(phone)}`;
  const json2 = await fetchJson(url2);
  if (json2?.data && Array.isArray(json2.data) && json2.data.length) {
    return json2.data[0];
  }

  // 4) No match
  return null;
}

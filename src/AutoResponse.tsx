import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "";

function defaultHours() {
  return {
    mon: "08:00-17:00",
    tue: "08:00-17:00",
    wed: "08:00-17:00",
    thu: "08:00-17:00",
    fri: "08:00-17:00",
    sat: "closed",
    sun: "closed",
  };
}

function hoursText(hours: any) {
  // e.g. "Mon-Fri: 08:00-17:00, Sat-Sun: closed"
  if (!hours) return "";
  if (typeof hours === "string") {
    try { hours = JSON.parse(hours); } catch { return hours; }
  }
  let work = [];
  for (let day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    work.push(
      `${day.charAt(0).toUpperCase() + day.slice(1)}: ${hours[day] || "closed"}`
    );
  }
  return work.join(", ");
}

export default function AutoResponse({ colors, darkMode }: any) {
  const [replies, setReplies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any | null>(null);
  const [msg, setMsg] = useState("");
  const [hours, setHours] = useState(defaultHours());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auto-replies`)
      .then(r => r.json())
      .then(data => {
        setReplies(data);
        setLoading(false);
      });
  }, []);

  const startEdit = (reply: any) => {
    setEditing(reply);
    setMsg(reply.reply);
    let h = defaultHours();
    if (reply.hours) {
      try { h = { ...h, ...JSON.parse(reply.hours) }; } catch { h = { ...h, ...reply.hours }; }
    }
    setHours(h);
  };

  const handleHourChange = (day: string, val: string) => {
    setHours({ ...hours, [day]: val });
  };

  const save = async () => {
    setSaving(true);
    await fetch(`${API_BASE}/api/auto-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editing.id,
        tag: editing.tag,
        hours: JSON.stringify(hours),
        reply: msg,
      }),
    });
    setEditing(null);
    setSaving(false);
    setLoading(true);
    fetch(`${API_BASE}/api/auto-replies`)
      .then(r => r.json())
      .then(setReplies)
      .finally(() => setLoading(false));
  };

  return (
    <div style={{
      maxWidth: 720,
      margin: "44px auto",
      background: colors.card,
      borderRadius: 14,
      boxShadow: "0 2px 14px #0001",
      padding: 32,
      color: colors.text,
    }}>
      <h2 style={{ color: colors.red, fontWeight: 800, marginBottom: 20 }}>Auto Responses</h2>
      {loading ? (
        <div style={{ color: colors.sub }}>Loading...</div>
      ) : (
        <table style={{ width: "100%", background: "transparent" }}>
          <thead>
            <tr>
              <th style={{ color: colors.th, textAlign: "left", fontWeight: 700, fontSize: 15, padding: "7px 12px" }}>Tag</th>
              <th style={{ color: colors.th, textAlign: "left", fontWeight: 700, fontSize: 15, padding: "7px 12px" }}>Office Hours</th>
              <th style={{ color: colors.th, textAlign: "left", fontWeight: 700, fontSize: 15, padding: "7px 12px" }}>Auto Reply</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {replies.map(reply => (
              <tr key={reply.id}>
                <td style={{ padding: "6px 12px" }}>{reply.tag}</td>
                <td style={{ padding: "6px 12px", minWidth: 180 }}>
                  {editing?.id === reply.id ? (
                    <div>
                      {Object.keys(defaultHours()).map(day => (
                        <div key={day} style={{ marginBottom: 4 }}>
                          <label style={{ minWidth: 55, display: "inline-block" }}>
                            {day.charAt(0).toUpperCase() + day.slice(1)}:
                          </label>
                          <input
                            value={hours[day]}
                            onChange={e => handleHourChange(day, e.target.value)}
                            style={{
                              width: 90,
                              borderRadius: 4,
                              border: `1px solid ${colors.border}`,
                              background: colors.input,
                              color: colors.inputText,
                              marginLeft: 3,
                            }}
                            placeholder="closed"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: 13, color: colors.sub }}>{hoursText(reply.hours)}</span>
                  )}
                </td>
                <td style={{ padding: "6px 12px" }}>
                  {editing?.id === reply.id ? (
                    <textarea
                      value={msg}
                      onChange={e => setMsg(e.target.value)}
                      style={{ width: "100%", fontSize: 15, borderRadius: 6, minHeight: 44 }}
                    />
                  ) : (
                    <span>{reply.reply}</span>
                  )}
                </td>
                <td style={{ padding: "6px 12px" }}>
                  {editing?.id === reply.id ? (
                    <button onClick={save} disabled={saving} style={{
                      background: colors.red,
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "5px 18px",
                      fontWeight: "bold"
                    }}>
                      Save
                    </button>
                  ) : (
                    <button onClick={() => startEdit(reply)} style={{
                      background: colors.input,
                      color: colors.inputText,
                      border: `1.3px solid ${colors.border}`,
                      borderRadius: 6,
                      padding: "5px 18px",
                      fontWeight: "bold"
                    }}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

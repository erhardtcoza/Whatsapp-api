import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "";

export default function AutoResponse({ colors, darkMode }: any) {
  const [replies, setReplies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any | null>(null);
  const [msg, setMsg] = useState("");
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auto-replies`)
      .then(r => r.json())
      .then(setReplies)
      .finally(() => setLoading(false));
  }, []);

  const startEdit = (reply: any) => {
    setEditing(reply);
    setMsg(reply.reply);
    setHours(reply.hours || "");
  };

  const save = async () => {
    setSaving(true);
    await fetch(`${API_BASE}/api/auto-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editing.id,
        tag: editing.tag,
        hours,
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
                <td style={{ padding: "6px 12px" }}>{reply.hours}</td>
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

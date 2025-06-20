import React, { useEffect, useState } from "react";

// Toolbar and header use your logo/colors
function AdminHeader() {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        borderBottom: "2px solid #e2001a",
        padding: "12px 16px",
        background: "#fff"
      }}
    >
      <img
        src="https://static.vinet.co.za/logo.jpeg"
        alt="Vinet Logo"
        style={{ height: 48, marginRight: 18 }}
      />
      <span
        style={{
          fontSize: "1.5rem",
          fontWeight: "bold",
          color: "#e2001a",
          letterSpacing: 1
        }}
      >
        Vinet WhatsApp Admin Portal
      </span>
    </header>
  );
}

// Chat list grouped by customer number
function ChatList({ chats, onSelect }) {
  return (
    <div>
      {chats.length === 0 && (
        <div style={{ color: "#aaa", textAlign: "center", marginTop: 36 }}>No chats.</div>
      )}
      {chats.map(chat => (
        <div
          key={chat.from_number}
          onClick={() => onSelect(chat)}
          style={{
            borderBottom: "1px solid #eee",
            padding: 12,
            background: "#fff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 12
          }}
        >
          <div style={{
            width: 44, height: 44, background: "#f0f0f0", borderRadius: 22,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: "bold", fontSize: 20, color: "#e2001a"
          }}>
            {chat.name ? chat.name[0].toUpperCase() : "?"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: "bold" }}>
              {chat.name || chat.from_number}
            </div>
            <div style={{ color: "#999", fontSize: 14 }}>
              {chat.last_message}
            </div>
          </div>
          {chat.unread_count > 0 && (
            <div style={{
              background: "#e2001a",
              color: "#fff",
              borderRadius: 12,
              padding: "2px 8px",
              fontSize: 12,
              fontWeight: "bold"
            }}>{chat.unread_count}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// Individual chat with reply form
function MessageSection({ chat, onBack }) {
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (chat) {
      fetch(`/api/messages?phone=${encodeURIComponent(chat.from_number)}`)
        .then(res => res.json())
        .then(setMessages);
    }
  }, [chat]);

  const handleSend = async e => {
    e.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    await fetch("/api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: chat.from_number, body: reply })
    });
    setReply("");
    setSending(false);
    // Reload
    fetch(`/api/messages?phone=${encodeURIComponent(chat.from_number)}`)
      .then(res => res.json())
      .then(setMessages);
  };

  return (
    <div style={{ background: "#fafafa", minHeight: "100vh" }}>
      <div
        style={{
          borderBottom: "2px solid #e2001a",
          padding: "12px 16px",
          background: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 12
        }}
      >
        <button onClick={onBack} style={{
          background: "#e2001a", color: "#fff", border: "none",
          borderRadius: 6, padding: "6px 14px", cursor: "pointer"
        }}>
          Back
        </button>
        <span style={{ fontWeight: "bold", fontSize: 18 }}>
          {chat.name || chat.from_number}
        </span>
      </div>
      <div style={{ padding: 16, paddingBottom: 90 }}>
        {messages.length === 0 && (
          <div style={{ color: "#aaa", marginTop: 32, textAlign: "center" }}>
            No messages yet.
          </div>
        )}
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              maxWidth: "70%",
              margin: msg.direction === "outgoing" ? "12px 0 12px auto" : "12px auto 12px 0",
              background: msg.direction === "outgoing" ? "#e2001a" : "#f1f1f1",
              color: msg.direction === "outgoing" ? "#fff" : "#222",
              borderRadius: 12,
              padding: "10px 14px",
              boxShadow: "0 2px 6px rgba(0,0,0,0.04)"
            }}
          >
            <div style={{ fontSize: 15 }}>{msg.body}</div>
            <div style={{ fontSize: 12, color: msg.direction === "outgoing" ? "#ffe0e0" : "#888", marginTop: 4 }}>
              {new Date(Number(msg.timestamp)).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <form
        onSubmit={handleSend}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "#fff",
          borderTop: "1px solid #eee",
          display: "flex",
          gap: 8,
          padding: 12
        }}
      >
        <input
          value={reply}
          onChange={e => setReply(e.target.value)}
          placeholder="Type a reply…"
          disabled={sending}
          style={{
            flex: 1,
            borderRadius: 6,
            border: "1px solid #ccc",
            padding: "10px 12px"
          }}
        />
        <button
          type="submit"
          disabled={sending || !reply.trim()}
          style={{
            background: "#e2001a",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "10px 18px",
            fontWeight: "bold",
            cursor: sending ? "wait" : "pointer"
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

// Main admin app
export default function AdminPortal() {
  const [chatList, setChatList] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);

  useEffect(() => {
    fetch("/api/chats")
      .then(res => res.json())
      .then(setChatList);
  }, [selectedChat]); // Refresh list when closing a chat

  return (
    <div>
      <AdminHeader />
      <div style={{ padding: 16, background: "#fff", borderBottom: "1px solid #eee" }}>
        <span style={{ fontWeight: "bold", fontSize: 18 }}>Recent Chats</span>
      </div>
      {!selectedChat ? (
        <ChatList chats={chatList} onSelect={setSelectedChat} />
      ) : (
        <MessageSection chat={selectedChat} onBack={() => setSelectedChat(null)} />
      )}
    </div>
  );
}

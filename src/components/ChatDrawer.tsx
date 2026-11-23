import React from "react";
import { Send, X, Bot, User, Sparkles } from "lucide-react";
import type { ChatMessage } from "../types/index.js";

interface ChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  city: string;
  aqi: number;
  band: string;
  members: string[];
}

interface ChatApiResponse {
  reply: string;
  isFallback?: boolean;
}

function isChatApiResponse(value: unknown): value is ChatApiResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const hasValidReply =
    typeof candidate.reply === "string" && candidate.reply.trim().length > 0;
  const hasValidFallback =
    candidate.isFallback === undefined ||
    typeof candidate.isFallback === "boolean";

  return hasValidReply && hasValidFallback;
}

function formatMessageContent(content: string, isFallback?: boolean): string {
  if (isFallback === true) {
    return content.replace(/^\[Offline mode[^\]]*\]\s*/i, "");
  }
  return content;
}

export const ChatDrawer: React.FC<ChatDrawerProps> = ({
  isOpen,
  onClose,
  city,
  aqi,
  band,
  members,
}) => {
  const [messages, setMessages] = React.useState<ChatMessage[]>([
    {
      id: "init-1",
      sender: "assistant",
      content: `Hello! I am your AirWise AI smog assistant. Current air in ${city} is ${band} (AQI ${aqi}). Ask me anything about creating clean-air rooms, commuting safely, or protecting your kids and elders.`,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  ]);
  const [input, setInput] = React.useState<string>("");
  const [loading, setLoading] = React.useState<boolean>(false);
  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);

  const suggestedQuestions: readonly string[] = [
    "Should my children attend morning sports in this air?",
    "How do I build a cheap DIY HEPA fan filter at home?",
    "Do indoor houseplants actually filter PM2.5 smog?",
    "When is the safest 2-hour window today to open windows?",
  ];

  const handleSend = async (questionText?: string): Promise<void> => {
    const trimmed = (questionText ?? input).trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      sender: "user",
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          aqi,
          band,
          city,
          members,
        }),
      });

      if (!res.ok) {
        throw new Error(`Chat API error: status ${res.status}`);
      }

      const raw: unknown = await res.json();
      if (!isChatApiResponse(raw)) {
        throw new Error("Invalid response payload from /api/chat");
      }

      const isOfflineFallback = raw.isFallback === true;
      const botMsg: ChatMessage = {
        id: `b-${Date.now()}`,
        sender: "assistant",
        content: raw.reply,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        isFallback: isOfflineFallback,
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `b-err-${Date.now()}`,
          sender: "assistant",
          content: `During ${band} air conditions in ${city}, keep windows closed, avoid outdoor exercise during morning inversions, and wear an N95 respirator outside. General guidance, not medical advice.`,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          isFallback: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [messages, loading, isOpen]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-title"
      className="fixed inset-0 z-50 overflow-hidden flex justify-end bg-slate-900/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col justify-between">
        {/* Header */}
        <div className="p-4 bg-emerald-800 text-white flex items-center justify-between border-b border-emerald-900">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-emerald-300" aria-hidden="true" />
            <div>
              <h2 id="chat-title" className="font-bold text-sm">
                AirWise AI Smog Assistant
              </h2>
              <div className="text-[11px] text-emerald-200">
                Ground context: {city} • AQI {aqi} ({band})
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-emerald-700 text-white focus:ring-2 focus:ring-white focus:outline-none"
            aria-label="Close chat drawer"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Message History */}
        <div className="flex-1 p-4 overflow-y-auto space-y-3 bg-slate-50">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex items-start gap-2 ${m.sender === "user" ? "flex-row-reverse" : ""}`}
            >
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs ${
                  m.sender === "user"
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-200 text-slate-800"
                }`}
              >
                {m.sender === "user" ? (
                  <User className="w-3.5 h-3.5" />
                ) : (
                  <Bot className="w-3.5 h-3.5" />
                )}
              </div>
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed shadow-sm ${
                  m.sender === "user"
                    ? "bg-emerald-600 text-white rounded-tr-none"
                    : "bg-white text-slate-800 border border-slate-200 rounded-tl-none"
                }`}
              >
                {m.sender === "assistant" && m.isFallback === true && (
                  <div className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5 mb-1.5">
                    Offline mode
                  </div>
                )}
                <div>{formatMessageContent(m.content, m.isFallback)}</div>
                <div
                  className={`text-[9px] mt-1 font-mono ${
                    m.sender === "user" ? "text-emerald-200" : "text-slate-400"
                  }`}
                >
                  {m.timestamp}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Bot className="w-4 h-4 animate-spin" />
              <span>AirWise is thinking...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Suggested Prompts */}
        <div className="p-3 bg-white border-t border-slate-100">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-amber-500" /> Suggested Prompts
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestedQuestions.map((q, idx) => (
              <button
                key={idx}
                type="button"
                disabled={loading}
                onClick={() => {
                  void handleSend(q);
                }}
                className="text-[11px] bg-slate-100 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50 text-slate-700 px-2.5 py-1 rounded-full border border-slate-200 transition-colors text-left focus:ring-1 focus:ring-emerald-500 focus:outline-none"
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Chat Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
          className="p-3 bg-white border-t border-slate-200 flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about smog hacks, air purifiers, masks..."
            maxLength={500}
            className="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
            aria-label="Your question to AirWise"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="p-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors focus:ring-2 focus:ring-emerald-400 focus:outline-none"
            aria-label="Send message"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
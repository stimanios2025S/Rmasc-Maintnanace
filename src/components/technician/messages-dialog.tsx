"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send, X } from "lucide-react";

/**
 * Le canal dispatch ↔ terrain d'un bon de travail.
 *
 * Une feuille ancrée en bas sur téléphone, une boîte centrée sur grand écran.
 * Elle interroge le fil toutes les 20 secondes quand elle est ouverte : le
 * bureau répond rarement en direct, mais une consigne qui attend dix minutes
 * dans un téléphone fermé n'aide personne sur le terrain.
 */

interface MessageRow {
  id: string;
  content: string;
  createdAt: string;
  sender: { id: string; name: string; role: string };
}

export function MessagesDialog({
  workOrderId,
  onClose,
}: {
  workOrderId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/work-orders/${workOrderId}/messages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRows(Array.isArray(json.data) ? json.data : []);
      setError("");
    } catch {
      setError("Conversation indisponible pour le moment.");
    } finally {
      setLoading(false);
    }
  }, [workOrderId]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [rows.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;

    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/work-orders/${workOrderId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setDraft("");
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Le message n'a pas pu être envoyé."
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-gray-900/50 backdrop-blur sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="messages-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl dark:bg-gray-900 sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <div className="min-w-0">
            <h2
              id="messages-title"
              className="flex items-center gap-2 text-base font-bold text-gray-900 dark:text-white"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              Prévenir le bureau
            </h2>
            <p className="text-xs text-gray-500">Canal avec le bureau</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-[8rem] flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Chargement…
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-500">
              Aucun message. Écrivez au dispatch : accès, pièce manquante,
              consigne, urgence.
            </p>
          ) : (
            rows.map((row) => {
              const mine = row.sender.role === "FIELD_TECHNICIAN";
              return (
                <div
                  key={row.id}
                  className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                      mine
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                    }`}
                  >
                    {row.content}
                  </div>
                  <p className="mt-1 text-[10px] text-gray-400">
                    {row.sender.name} ·{" "}
                    {new Date(row.createdAt).toLocaleTimeString("fr-FR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <p
            role="alert"
            className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <div className="border-t border-gray-200 p-3 dark:border-gray-800">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder="Votre message au bureau…"
              aria-label="Message au dispatch"
              className="flex-1 resize-none rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:focus:ring-blue-900"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!draft.trim() || sending}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
              Envoyer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

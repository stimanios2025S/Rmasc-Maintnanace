"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, CheckCheck, Loader2 } from "lucide-react";

/**
 * The user's own notification tray.
 *
 * Separate from the alert bell beside it: an alert is a machine saying the
 * fleet has a problem, a notification is a message addressed to one person
 * ("this incident is yours", "the fault you reported was closed"). They are
 * read differently and one cannot stand in for the other.
 *
 * Best effort throughout. A failure to load, or to mark read, must leave the
 * chrome intact — a broken mailbox is not a reason to lose the sidebar.
 */

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  type: string;
  linkUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=8");
      if (!res.ok) return;
      const json = await res.json();
      setRows(Array.isArray(json.data) ? json.data : []);
      setUnread(typeof json.unread === "number" ? json.unread : 0);
    } catch {
      // Keep the tray quiet.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [enabled, load]);

  // Close on an outside click or Escape. A dropdown that only closes via its
  // own trigger is a small but real keyboard trap.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function openRow(row: NotificationRow) {
    setOpen(false);

    // Optimistic: the badge drops immediately, and a failed write only means
    // the row comes back unread on the next poll.
    if (!row.isRead) {
      setUnread((n) => Math.max(0, n - 1));
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, isRead: true } : r))
      );
      void fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      }).catch(() => undefined);
    }

    if (row.linkUrl) router.push(row.linkUrl);
  }

  async function markAllRead() {
    setLoading(true);
    setUnread(0);
    setRows((prev) => prev.map((r) => ({ ...r, isRead: true })));

    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      // Next poll restores the true state.
    } finally {
      setLoading(false);
    }
  }

  if (!enabled) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          unread > 0 ? `${unread} unread notifications` : "Notifications"
        }
        title={unread > 0 ? `${unread} unread notifications` : "Notifications"}
        className="relative rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <BellRing className="h-5 w-5 text-gray-500" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900"
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">
              Notifications
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={loading}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline disabled:opacity-60 dark:text-blue-400"
              >
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCheck className="h-3 w-3" aria-hidden="true" />
                )}
                Mark all read
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
              Nothing new.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void openRow(row)}
                    className={`block w-full px-4 py-3 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 ${
                      row.isRead ? "" : "bg-blue-50/60 dark:bg-blue-950/20"
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      {!row.isRead && (
                        <span
                          aria-hidden="true"
                          className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-600"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-gray-900 dark:text-white">
                          {row.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">
                          {row.message}
                        </span>
                        <span className="mt-1 block text-[10px] uppercase tracking-wide text-gray-400">
                          {timeAgo(row.createdAt)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-gray-200 px-4 py-2.5 dark:border-gray-800">
            <Link
              href="/client"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              View my reported faults
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

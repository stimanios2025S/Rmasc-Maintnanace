"use client";

import { AlertTriangle, Inbox } from "lucide-react";

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse"
        />
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-center">
      <AlertTriangle className="w-6 h-6 text-red-500 mx-auto mb-2" />
      <p className="text-sm font-medium text-red-700 dark:text-red-300">
        {message}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 px-4 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-8 text-center">
      <Inbox className="w-6 h-6 text-gray-400 mx-auto mb-2" />
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {title}
      </p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

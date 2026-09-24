"use client";

import { useEffect } from "react";

/**
 * Root error boundary. Without this file an unhandled render error showed the
 * bare Next.js error overlay in development and a blank screen in production.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled render error", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
          Une erreur est survenue
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          La page n&apos;a pas pu être affichée. Cet incident a été enregistré.
          {error.digest && (
            <>
              {" "}
              Référence :{" "}
              <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">
                {error.digest}
              </code>
            </>
          )}
        </p>
        <button
          onClick={reset}
          className="mt-4 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          Réessayer
        </button>
      </div>
    </div>
  );
}

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <p className="text-sm font-semibold text-blue-600">404</p>
        <h1 className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          The page you were looking for does not exist, or you may not have
          access to it.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

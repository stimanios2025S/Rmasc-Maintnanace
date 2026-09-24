import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <p className="text-sm font-semibold text-blue-600">404</p>
        <h1 className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
          Page introuvable
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          La page que vous recherchez n&apos;existe pas, ou vous n&apos;y avez
          pas accès.
        </p>
        <Link
          href="/tableau-de-bord"
          className="mt-4 inline-block px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          Retour au tableau de bord
        </Link>
      </div>
    </div>
  );
}

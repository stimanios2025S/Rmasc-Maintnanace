"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { ErrorState } from "@/components/ui/states";

/**
 * A finished inspection report, as a document.
 *
 * NO APPLICATION CHROME, ON PURPOSE
 * This page deliberately does not render `AppShell`. A service report is a
 * record — it gets printed, signed, filed and handed to a client — and a
 * sidebar, a notification bell and a "sign out" button have no business on
 * it. It is the only screen in the application that renders bare, and that is
 * the whole point of it.
 *
 * The one control it does carry, a print button, is marked `print:hidden` so
 * it does not appear on the paper it produces.
 */

interface CheckItem {
  id: string;
  checkName: string;
  result: "PASS" | "FAIL" | "NEEDS_ATTENTION" | "NOT_APPLICABLE";
  notes: string | null;
  measuredValue: number | null;
  unit: string | null;
  photoUrl: string | null;
}

interface Signature {
  role: string;
  name: string;
  method: string;
  signedAt: string;
  imageDataUrl?: string;
}

interface Report {
  id: string;
  reportNumber: string;
  title: string;
  summary: string | null;
  overallResult: string;
  submittedAt: string;
  signatures: Signature[] | null;
  technician: { id: string; name: string | null };
  checkItems: CheckItem[];
  workOrder: {
    id: string;
    orderNumber: string;
    title: string;
    type: string;
    priority: string;
    status: string;
    completedAt: string | null;
  };
  elevator: {
    id: string;
    elevatorCode: string;
    brand: string;
    model: string;
    building: { name: string; address: string; city: string };
  };
}

const RESULT_STYLE: Record<string, string> = {
  PASS: "text-emerald-700 border-emerald-300 bg-emerald-50",
  FAIL: "text-red-700 border-red-300 bg-red-50",
  NEEDS_ATTENTION: "text-amber-700 border-amber-300 bg-amber-50",
  NOT_APPLICABLE: "text-gray-600 border-gray-300 bg-gray-50",
};

const RESULT_LABEL: Record<string, string> = {
  PASS: "Conforme",
  FAIL: "Non conforme",
  NEEDS_ATTENTION: "À surveiller",
  NOT_APPLICABLE: "Sans objet",
};

/**
 * How a signature was produced, as the report prints it.
 *
 * The stored values (`DRAWN` / `TYPED`) are the API's; these are what the
 * sheet says.
 */
const METHOD_LABEL: Record<string, string> = {
  DRAWN: "manuscrite",
  TYPED: "saisie",
};

/** The signature roles the API writes. `TECHNICIAN` is the only one in use. */
const SIGNATURE_ROLE_LABEL: Record<string, string> = {
  TECHNICIAN: "Technicien",
  CLIENT: "Client",
  SUPERVISOR: "Responsable",
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  // Explicit locale rather than the runtime default: the report is printed and
  // filed, so its date format must not depend on the machine that opened it.
  return date.toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

export default function InspectionReportPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(
        `/api/inspection-reports?id=${encodeURIComponent(params.id)}`
      );
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "Ce rapport n'existe pas, ou ne vous est pas accessible."
            : `Impossible de charger le rapport (${res.status}).`
        );
      }
      const json = await res.json();
      setReport(json.data ?? null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Impossible de charger le rapport."
      );
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState message={error || "Rapport introuvable"} onRetry={load} />
      </div>
    );
  }

  const failures = report.checkItems.filter((i) => i.result === "FAIL").length;
  const attention = report.checkItems.filter(
    (i) => i.result === "NEEDS_ATTENTION"
  ).length;

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      {/* Screen-only toolbar. Hidden in print so the paper carries the report
          and nothing else. */}
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-3 print:hidden">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Retour
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            Imprimer / Enregistrer en PDF
          </button>
        </div>
      </div>

      <article className="mx-auto my-6 max-w-3xl bg-white p-8 shadow-sm print:my-0 print:max-w-none print:p-0 print:shadow-none">
        <header className="border-b border-gray-300 pb-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            ElevatorPulse · Rapport d&apos;inspection
          </p>
          <h1 className="mt-2 text-2xl font-bold text-gray-900">
            {report.title}
          </h1>
          <p className="mt-1 font-mono text-sm text-gray-600">
            {report.reportNumber}
          </p>
        </header>

        <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-gray-500">Ascenseur</dt>
            <dd className="font-semibold text-gray-900">
              {report.elevator.elevatorCode}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Marque / modèle</dt>
            <dd className="text-gray-900">
              {report.elevator.brand} {report.elevator.model}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Site</dt>
            <dd className="text-gray-900">{report.elevator.building.name}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Adresse</dt>
            <dd className="text-gray-900">
              {report.elevator.building.address},{" "}
              {report.elevator.building.city}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Bon de travail</dt>
            <dd className="font-mono text-gray-900">
              {report.workOrder.orderNumber}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Technicien</dt>
            <dd className="text-gray-900">
              {report.technician.name ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Transmis le</dt>
            <dd className="text-gray-900">
              {formatDateTime(report.submittedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Intervention terminée le</dt>
            <dd className="text-gray-900">
              {formatDateTime(report.workOrder.completedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Résultat global</dt>
            <dd className="mt-0.5">
              <span
                className={`inline-block rounded border px-2 py-0.5 text-xs font-bold ${
                  RESULT_STYLE[report.overallResult] ?? RESULT_STYLE.NOT_APPLICABLE
                }`}
              >
                {RESULT_LABEL[report.overallResult] ?? report.overallResult}
              </span>
            </dd>
          </div>
        </dl>

        {report.summary && (
          <section className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Synthèse
            </h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-gray-800">
              {report.summary}
            </p>
          </section>
        )}

        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Points de contrôle
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {report.checkItems.length}{" "}
            {report.checkItems.length > 1 ? "points" : "point"} · {failures} non
            conforme{failures > 1 ? "s" : ""} · {attention} à surveiller
          </p>

          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 pr-3 font-semibold">Point de contrôle</th>
                <th className="py-2 pr-3 font-semibold">Résultat</th>
                <th className="py-2 pr-3 font-semibold">Mesuré</th>
                <th className="py-2 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {report.checkItems.map((item) => (
                <tr key={item.id} className="border-b border-gray-200 align-top">
                  <td className="py-2 pr-3 text-gray-900">{item.checkName}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${
                        RESULT_STYLE[item.result] ?? RESULT_STYLE.NOT_APPLICABLE
                      }`}
                    >
                      {RESULT_LABEL[item.result] ?? item.result}
                    </span>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-gray-700">
                    {item.measuredValue === null
                      ? "—"
                      : `${item.measuredValue}${item.unit ? ` ${item.unit}` : ""}`}
                  </td>
                  <td className="py-2 text-gray-700">
                    {item.notes ?? "—"}
                    {item.photoUrl && (
                      // Printed as a link, not an image: the sheet has to stay
                      // legible on paper, and a thumbnail of a nameplate is
                      // useless at print resolution anyway. The reference
                      // survives the paper.
                      <span className="mt-1 block text-xs text-blue-700">
                        Photo : {item.photoUrl}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-8 break-inside-avoid">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Signatures
          </h2>

          {!report.signatures || report.signatures.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">
              Aucune signature n&apos;a été enregistrée avec ce rapport.
            </p>
          ) : (
            <div className="mt-3 grid gap-6 sm:grid-cols-2">
              {report.signatures.map((signature, index) => (
                <div
                  key={`${signature.role}-${index}`}
                  className="break-inside-avoid"
                >
                  <p className="text-xs uppercase tracking-wide text-gray-500">
                    {SIGNATURE_ROLE_LABEL[signature.role] ?? signature.role}
                  </p>
                  {signature.imageDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={signature.imageDataUrl}
                      alt={`Signature de ${signature.name}`}
                      className="mt-1 h-16 w-full max-w-[16rem] border-b border-gray-400 object-contain object-left"
                    />
                  ) : (
                    <p className="mt-2 border-b border-gray-400 pb-1 font-serif text-lg italic text-gray-900">
                      {signature.name}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-gray-600">
                    {signature.name} · signé le{" "}
                    {formatDateTime(signature.signedAt)} (
                    {METHOD_LABEL[signature.method] ??
                      signature.method.toLowerCase()}
                    )
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="mt-10 border-t border-gray-300 pt-3 text-xs text-gray-500">
          Document généré par ElevatorPulse. Ce rapport constate l&apos;état de
          l&apos;équipement au moment de l&apos;inspection et n&apos;atteste pas
          de son aptitude à l&apos;usage au-delà des points listés ci-dessus.
        </footer>
      </article>
    </div>
  );
}

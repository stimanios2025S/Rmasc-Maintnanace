"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Phone,
  RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";

/**
 * The portal for a client we hold no maintenance contract with.
 *
 * WHY IT IS SO MUCH SMALLER THAN THE OTHER ONE
 * The contracted portal is built around equipment we already know about: the
 * emergency button escalates a fault on a named elevator, and the wizard walks
 * through that unit's error codes. None of that can exist here — a
 * non-contracted client has no building, no elevator and no error-code history
 * in the system, because that is precisely what "no contract" means.
 *
 * So this portal does the one thing that is possible and useful: it collects
 * the « Fiche Technique ». That form is the first contact, and completing it is
 * how the relationship starts.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * There is no fault reporting. An incident in this system must point at an
 * elevator (`IncidentReport.elevatorId` is required), so a report filed from
 * this account could not be stored without inventing equipment. The card at
 * the bottom says so plainly and sends the person to the phone instead, which
 * is honest and takes one line — better than a form that fails on submit.
 */

interface SheetRow {
  id: string;
  location: string;
  weightCapacity: string;
  numberOfFloors: string;
  createdAt: string;
}

export function NonContractedPortal() {
  const [sheets, setSheets] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/technical-sheets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      setSheets(payload?.data?.sheets ?? []);
    } catch {
      setError("Impossible de charger vos fiches techniques.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasSheet = sheets.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Espace client
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Vous n&apos;avez pas encore de contrat d&apos;entretien avec nous.
          Remplissez la fiche technique de votre installation : c&apos;est le
          point de départ, et notre équipe technique relèvera le reste sur
          place.
        </p>
      </div>

      <Card className="p-6">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/30">
            <FileSpreadsheet
              className="h-5 w-5 text-blue-600 dark:text-blue-400"
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              Fiche technique
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Quatre informations suffisent pour commencer : votre nom,
              l&apos;adresse, la capacité et le nombre d&apos;étages. Tout le
              reste est facultatif — remplissez ce que vous savez, nous
              compléterons lors de la visite.
            </p>
          </div>
          <Link
            href="/client/fiche-technique"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            {hasSheet ? "Remplir une autre fiche" : "Remplir la fiche"}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
            <FileSpreadsheet
              className="h-5 w-5 text-gray-400"
              aria-hidden="true"
            />
            Mes fiches transmises
          </h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Actualiser
          </button>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        )}

        {!error && loading && (
          <div className="mt-4 h-16 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />
        )}

        {!error && !loading && sheets.length === 0 && (
          <div className="mt-4">
            <EmptyState
              title="Aucune fiche pour le moment"
              hint="Votre fiche apparaîtra ici dès que vous l'aurez envoyée."
            />
          </div>
        )}

        {!error && !loading && sheets.length > 0 && (
          <ul className="mt-4 space-y-3">
            {sheets.map((sheet) => (
              <li
                key={sheet.id}
                className="rounded-xl border border-gray-200 p-4 dark:border-gray-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <CheckCircle2
                    className="h-4 w-4 text-emerald-500"
                    aria-hidden="true"
                  />
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {sheet.location}
                  </span>
                  <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                    {format(new Date(sheet.createdAt), "d MMMM yyyy", {
                      locale: fr,
                    })}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {sheet.weightCapacity} kg · {sheet.numberOfFloors} étages
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Said plainly rather than left as an absent button. Someone whose lift
          has stopped will look for the red button they have heard about, and
          an explanation costs one card while a dead end costs a phone call
          anyway. */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
            <Phone className="h-5 w-5 text-gray-500" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">
              Une panne à signaler ?
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Le signalement en ligne est réservé aux clients sous contrat,
              parce qu&apos;il s&apos;appuie sur un ascenseur déjà enregistré
              chez nous. En attendant votre contrat, appelez-nous : nous
              interviendrons de la même façon.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

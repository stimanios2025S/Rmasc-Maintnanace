/**
 * La page que le QR collé sur un appareil ouvre.
 *
 * POURQUOI ELLE EST PUBLIQUE
 * La personne qui scanne un QR dans une cage d'escalier n'a, par définition,
 * aucun compte : c'est un gardien, un syndic ou un propriétaire qui vient de
 * voir la plaque pour la première fois. Exiger une connexion rendrait le QR
 * inutile, et c'est bien un *accès* qu'il vient demander.
 *
 * CE QU'ELLE MONTRE, ET RIEN DE PLUS
 * L'état de la machine, son matricule, l'immeuble et la date de la dernière
 * visite — c'est-à-dire ce que la plaque apposée sur l'appareil affiche déjà.
 * Ni le propriétaire, ni les contacts du site, ni l'historique des pannes, ni
 * les identifiants des autres demandes. La requête ci-dessous est écrite en
 * liste blanche : ajouter un champ au modèle ne le publie pas ici par accident.
 *
 * Le dépôt d'une demande passe par `POST /api/access-requests`, qui écrit une
 * ligne PENDING et n'ouvre aucun accès. La décision reste au bureau.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { AccessRequestForm } from "@/components/scan/access-request-form";
import { FaultDiagnostic } from "@/components/scan/fault-diagnostic";
import { demoWorld } from "@/lib/demo/dataset";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Accès appareil — RMASC",
  robots: { index: false, follow: false },
};

const STATUS_LABELS: Record<string, string> = {
  OPERATIONAL: "En service",
  SERVICE_REQUIRED: "Entretien requis",
  ANOMALY_DETECTED: "Anomalie détectée",
  CRITICAL_SHUTDOWN: "Arrêt critique",
  OFFLINE: "Hors ligne",
};

/**
 * Le ton de la pastille d'état.
 *
 * Les mêmes couleurs que le tableau de bord : une machine en arrêt critique
 * doit se reconnaître à la couleur avant que le mot ne soit lu.
 */
const STATUS_STYLES: Record<string, string> = {
  OPERATIONAL: "bg-emerald-100 text-emerald-800",
  SERVICE_REQUIRED: "bg-amber-100 text-amber-800",
  ANOMALY_DETECTED: "bg-orange-100 text-orange-800",
  CRITICAL_SHUTDOWN: "bg-red-100 text-red-800",
  OFFLINE: "bg-gray-200 text-gray-700",
};

const BRAND_LABELS: Record<string, string> = {
  OTIS: "Otis",
  SCHINDLER: "Schindler",
  THYSSENKRUPP: "ThyssenKrupp",
  MITSUBISHI: "Mitsubishi",
  HITACHI: "Hitachi",
  KONE: "KONE",
  OTHER: "Autre",
};

function formatDay(value: Date | null): string {
  if (!value) return "Aucune visite enregistrée";
  return value.toLocaleDateString("fr-FR", { dateStyle: "long" });
}

export default async function ScanPage({
  params,
}: {
  params: { elevatorId: string };
}) {
  let elevator: {
    id: string;
    elevatorCode: string;
    brand: string;
    originBrand: string | null;
    rmascCode: string | null;
    model: string;
    status: string;
    building: { name: string; city: string };
    inspectionReports: { submittedAt: Date }[];
  } | null = null;

  try {
    elevator = await prisma.elevator.findFirst({
      where: { id: params.elevatorId, isActive: true },
      select: {
        id: true,
        elevatorCode: true,
        brand: true,
        originBrand: true,
        rmascCode: true,
        model: true,
        status: true,
        building: { select: { name: true, city: true } },
        // La dernière visite, toutes feuilles confondues : c'est la question
        // qu'un gardien pose au téléphone — « quand est-on passé la dernière
        // fois ? »
        inspectionReports: {
          select: { submittedAt: true },
          orderBy: { submittedAt: "desc" as const },
          take: 1,
        },
      },
    });
  } catch (error) {
    /**
     * Une base indisponible ne doit pas jeter une page publique.
     *
     * En développement — pas de PostgreSQL — la page se rabat sur le monde de
     * démonstration, comme les autres écrans. Sans ce repli, le QR qui doit
     * justement servir quand tout va mal affichait « Appareil introuvable ».
     */
    console.error("[scan] lecture de l'appareil impossible", error);

    try {
      const world = demoWorld();
      const demoElevator = world.elevators.find(
        (candidate) => candidate.id === params.elevatorId && candidate.isActive
      );
      const demoBuilding = demoElevator
        ? world.buildings.find(
            (candidate) => candidate.id === demoElevator.buildingId
          )
        : undefined;

      if (demoElevator) {
        elevator = {
          id: demoElevator.id,
          elevatorCode: demoElevator.elevatorCode,
          brand: demoElevator.brand,
          originBrand: demoElevator.originBrand ?? null,
          rmascCode: demoElevator.rmascCode ?? null,
          model: demoElevator.model,
          status: demoElevator.status,
          building: {
            name: demoBuilding?.name ?? "Immeuble non renseigné",
            city: demoBuilding?.city ?? "",
          },
          inspectionReports: [],
        };
      }
    } catch {
      // Même le repli a échoué : la page rend l'écran « introuvable ».
    }
  }

  if (!elevator) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-950">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Maintenance RMASC
          </p>
          <h1 className="mt-3 text-xl font-bold text-gray-900 dark:text-white">
            Appareil introuvable
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Ce QR code ne correspond à aucun appareil de notre parc. Vérifiez la
            plaque, ou contactez le bureau.
          </p>
          <Link
            href="/connexion"
            className="mt-6 inline-block text-sm font-medium text-blue-600 hover:underline"
          >
            Espace professionnel
          </Link>
        </div>
      </main>
    );
  }

  const lastVisit = elevator.inspectionReports[0]?.submittedAt ?? null;
  const brandLabel = elevator.originBrand?.trim()
    ? elevator.originBrand
    : BRAND_LABELS[elevator.brand] ?? elevator.brand;

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-lg space-y-6">
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Maintenance RMASC
          </p>
          <h1 className="mt-2 font-mono text-2xl font-bold text-gray-900 dark:text-white">
            {elevator.rmascCode ?? elevator.elevatorCode}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {elevator.building.name} · {elevator.building.city}
          </p>
        </header>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-400">
                Appareil
              </p>
              <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">
                {brandLabel} {elevator.model}
              </p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                STATUS_STYLES[elevator.status] ?? STATUS_STYLES.OFFLINE
              }`}
            >
              {STATUS_LABELS[elevator.status] ?? elevator.status}
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 text-sm dark:border-gray-800">
            <div>
              <dt className="text-xs text-gray-400">Dernière visite</dt>
              <dd className="mt-0.5 text-gray-700 dark:text-gray-300">
                {formatDay(lastVisit)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-400">Code appareil</dt>
              <dd className="mt-0.5 font-mono text-gray-700 dark:text-gray-300">
                {elevator.elevatorCode}
              </dd>
            </div>
          </dl>
        </section>

        <FaultDiagnostic
          elevatorId={elevator.id}
          elevatorCode={elevator.rmascCode ?? elevator.elevatorCode}
        />

        <AccessRequestForm elevatorId={elevator.id} />

        <p className="text-center text-xs text-gray-400">
          Cet appareil est suivi par SARL RMASC. Une demande d&apos;accès est
          vérifiée par le bureau avant d&apos;ouvrir un compte.
        </p>
      </div>
    </main>
  );
}

/**
 * Le badge de contrat d'un appareil.
 *
 * CE QU'IL LIT, ET CE QU'IL NE LIT PAS
 * Il ne prend ni `Building.slaTier` ni une étiquette figée : il reçoit la
 * couverture calculée par `GET /api/contracts/coverage`, c'est-à-dire le
 * contrat réellement en vigueur pour l'immeuble, son palier et son état
 * calculé. La différence n'est pas cosmétique — un immeuble dont le palier
 * d'étiquette dit `PREMIUM` mais dont le contrat a été résilié doit afficher
 * « Hors contrat », pas une promesse que l'entreprise ne tient plus.
 *
 * TROIS ÉTATS, PAS DEUX
 * `ACTIVE` est le cas normal. `SUSPENDED` garde son palier mais le dit : les
 * immeubles restent couverts administrativement, le service est arrêté. Les
 * confondre avec « en vigueur » ferait lire une promesse de délai qui n'est pas
 * tenue. L'absence de contrat se lit « Hors contrat ».
 *
 * Composant sans état ni effet : il s'importe indifféremment dans un écran
 * client ou serveur.
 */

import type { SLATier } from "@/types";
import { enumLabel } from "@/lib/ui/enum-labels";
import type { CoverageContract } from "@/lib/contracts/coverage";

interface Tone {
  badge: string;
  dot: string;
}

/** Une couleur par palier : le palier se reconnaît avant d'être lu. */
const TIER_TONES: Record<SLATier, Tone> = {
  BASIC: {
    badge:
      "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    dot: "bg-gray-400",
  },
  STANDARD: {
    badge:
      "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  PREMIUM: {
    badge:
      "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
    dot: "bg-indigo-500",
  },
  ENTERPRISE: {
    badge:
      "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    dot: "bg-amber-500",
  },
};

const SUSPENDED_TONE: Tone = {
  badge: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  dot: "bg-amber-500",
};

const NO_CONTRACT_TONE: Tone = {
  badge: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  dot: "bg-gray-300 dark:bg-gray-600",
};

export function ContractSlaBadge({
  contract,
  size = "md",
  showReference = false,
}: {
  contract: CoverageContract | null;
  size?: "sm" | "md";
  /** Affiche la référence du contrat à côté du palier. */
  showReference?: boolean;
}) {
  const sizing =
    size === "sm" ? "gap-1 px-2 py-0.5 text-[10px]" : "gap-1.5 px-2.5 py-1 text-xs";

  if (!contract) {
    return (
      <span
        className={`inline-flex items-center rounded-full font-semibold ${sizing} ${NO_CONTRACT_TONE.badge}`}
        title="Aucun contrat actif ne couvre cet immeuble."
      >
        <span
          className={`mr-1 h-1.5 w-1.5 rounded-full ${NO_CONTRACT_TONE.dot}`}
          aria-hidden="true"
        />
        Hors contrat
      </span>
    );
  }

  const suspended = contract.effectiveStatus === "SUSPENDED";
  const tone = suspended
    ? SUSPENDED_TONE
    : TIER_TONES[contract.slaTier] ?? NO_CONTRACT_TONE;

  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ${sizing} ${tone.badge}`}
      title={`Contrat ${contract.reference} — ${
        suspended ? "suspendu" : "en vigueur"
      } · palier ${enumLabel(contract.slaTier)}`}
    >
      <span
        className={`mr-1 h-1.5 w-1.5 rounded-full ${tone.dot}`}
        aria-hidden="true"
      />
      SLA {enumLabel(contract.slaTier)}
      {suspended && " · suspendu"}
      {showReference && (
        <span className="ml-1 font-mono font-normal opacity-70">
          {contract.reference}
        </span>
      )}
    </span>
  );
}

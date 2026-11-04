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
 * UNE COULEUR QUI VEUT DIRE QUELQUE CHOSE
 * Le badge suivait la couleur du palier (gris, bleu, indigo, ambre) : un
 * lecteur pouvait croire qu'un palier élevé était « plus vert » qu'un palier
 * bas. La refonte UX a tranché — vert = contrat actif, orange = à surveiller
 * (suspendu ou proche de l'échéance), rouge = hors contrat ou résilié. Le
 * palier reste écrit, il ne décide plus de la couleur.
 *
 * Composant sans état ni effet : il s'importe indifféremment dans un écran
 * client ou serveur.
 */

import { enumLabel } from "@/lib/ui/enum-labels";
import type { CoverageContract } from "@/lib/contracts/coverage";
import {
  TRAFFIC_LEVELS,
  contractTrafficLabel,
  contractTrafficLevel,
} from "@/lib/ui/traffic";

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

  const level = contractTrafficLevel(contract);
  const tone = TRAFFIC_LEVELS[level];
  const label = contractTrafficLabel(contract);

  if (!contract) {
    return (
      <span
        className={`inline-flex items-center rounded-full border font-semibold ${sizing} ${tone.bg} ${tone.border} ${tone.text}`}
        title="Aucun contrat actif ne couvre cet immeuble. Contactez le bureau pour régulariser."
      >
        <span
          className={`mr-1 h-1.5 w-1.5 rounded-full ${tone.dot}`}
          aria-hidden="true"
        />
        Hors contrat
      </span>
    );
  }

  const suspended = contract.effectiveStatus === "SUSPENDED";

  return (
    <span
      className={`inline-flex items-center rounded-full border font-semibold ${sizing} ${tone.bg} ${tone.border} ${tone.text}`}
      title={`Contrat ${contract.reference} — ${label} · palier ${enumLabel(
        contract.slaTier
      )} · prise en charge ${contract.responseHours} h, intervention ${contract.interventionHours} h`}
    >
      <span
        className={`mr-1 h-1.5 w-1.5 rounded-full ${tone.dot}`}
        aria-hidden="true"
      />
      Contrat {enumLabel(contract.slaTier)}
      {suspended && " · suspendu"}
      {showReference && (
        <span className="ml-1 font-mono font-normal opacity-70">
          {contract.reference}
        </span>
      )}
    </span>
  );
}

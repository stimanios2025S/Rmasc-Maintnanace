/**
 * Le journal des corrections apportées à un rapport soumis.
 *
 * POURQUOI CE MODULE EXISTE
 * Le bureau peut corriger le montant, la description et les pièces d'un rapport
 * avant de le valider. Cette possibilité n'est défendable que si la correction
 * laisse une trace : sans elle, un montant tapé par un technicien et un montant
 * retapé au bureau sont le même chiffre en base, et le jour où un client
 * conteste sa facture, personne ne peut dire lequel des deux a été saisi sur le
 * terrain. Voir `WorkOrderRevision` dans `schema.prisma` pour l'arbitrage entre
 * ce journal et la doctrine « pas d'historique » des colonnes WhatsApp.
 *
 * POURQUOI LE DIFF EST ICI ET PAS DANS LA ROUTE
 * Parce que c'est la seule partie de la fonctionnalité qui a une règle à elle —
 * *quand* une correction mérite une ligne — et qu'une règle enfouie au milieu
 * d'un handler de trois cents lignes n'est vérifiable qu'en la relisant. Ici
 * elle s'écrit en une fonction pure, sur des instantanés, et la route se
 * contente d'appeler.
 *
 * CE QUI NE MÉRITE PAS DE LIGNE
 * Rien de ce qui n'a pas changé. Le formulaire renvoie tous les champs à chaque
 * décision — c'est ce qui rend la validation et la correction atomiques — donc
 * un bureau qui valide sans rien toucher envoie exactement les valeurs déjà en
 * base. Comparer avant d'écrire n'est pas une optimisation, c'est ce qui
 * empêche le journal de se remplir de lignes vides à chaque rapport validé.
 */

/** Les champs du rapport qu'un bureau peut corriger, plus le renvoi. */
export type RevisionField =
  | "notes"
  | "isBillable"
  | "invoiceAmount"
  | "partsReplaced"
  | "status";

/** Une ligne de journal, sans son auteur : celui-ci est connu de l'appelant. */
export interface RevisionDraft {
  field: RevisionField;
  oldValue: string | null;
  newValue: string | null;
  note?: string;
}

/** L'état commercial d'un rapport, réduit à ce qui se compare. */
export interface ReportSnapshot {
  /** Le texte du technicien — `WorkOrder.notes`. */
  notes: string | null;
  isBillable: boolean;
  /** Déjà en texte : un `Decimal` Prisma ne survit pas à une sérialisation. */
  invoiceAmount: string | null;
  partsReplaced: unknown;
}

/**
 * Rend une liste de pièces lisible dans un journal.
 *
 * Le journal imprime ses valeurs, il ne les relit pas — c'est écrit noir sur
 * blanc dans le commentaire du modèle. Stocker le JSON de `partsReplaced`
 * respecterait la lettre de cette règle tout en la trahissant : une ligne
 * « [{"name":"Contacteur","qty":1}] » dans une chronologie de facturation ne
 * dit rien à personne.
 *
 * Les champs sont lus dans un ordre fixe, ce qui rend la comparaison fiable
 * sans avoir à trier les clés des objets : deux listes identiques produisent la
 * même phrase.
 */
export function describeParts(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const parts = value.map((line) => {
    const part = line as { name?: unknown; partNumber?: unknown; qty?: unknown };
    const name = typeof part.name === "string" ? part.name.trim() : "";
    if (name === "") return "";
    const ref =
      typeof part.partNumber === "string" && part.partNumber.trim() !== ""
        ? ` (${part.partNumber.trim()})`
        : "";
    const qty = typeof part.qty === "number" ? part.qty : Number(part.qty);
    const suffix = Number.isFinite(qty) ? ` ×${qty}` : "";
    return `${name}${ref}${suffix}`;
  });

  const kept = parts.filter((p) => p !== "");
  return kept.length === 0 ? null : kept.join(", ");
}

/**
 * Un `Decimal` Prisma, ou `null`, en texte.
 *
 * `String(decimal)` et non `toFixed(2)` : le dinar n'a pas de centimes en usage
 * courant, et une colonne qui contient 18500 s'afficherait « 18500.00 » dans la
 * chronologie alors que le technicien avait tapé « 18500 ». Le journal doit
 * rapporter ce qui a été saisi, pas la précision de la colonne.
 */
export function decimalToText(
  value: { toString(): string } | null | undefined
): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/**
 * Les lignes à écrire pour passer de `before` à `after`.
 *
 * Aucune ligne n'est produite pour un champ inchangé, et aucune n'est produite
 * si les deux instantanés sont identiques — c'est le cas normal quand le bureau
 * valide un rapport sans y toucher, et il ne doit rien écrire.
 */
export function diffReport(
  before: ReportSnapshot,
  after: ReportSnapshot
): RevisionDraft[] {
  const drafts: RevisionDraft[] = [];

  // Le texte du rapport. La comparaison porte sur la valeur brute et non sur
  // une version normalisée : un bureau qui reformule une phrase a corrigé le
  // rapport, et c'est exactement ce que la ligne doit consigner.
  if (before.notes !== after.notes) {
    drafts.push({
      field: "notes",
      oldValue: before.notes,
      newValue: after.notes,
    });
  }

  // Le caractère facturable et le montant sont deux champs distincts, mais un
  // seul fait commercial : « ce n'est pas facturé » et « c'est facturé 18 500 »
  // sont la même décision prise dans deux sens. Les journaliser séparément
  // laisse la chronologie montrer les deux moitiés du changement, ce qu'une
  // ligne unique et combinée ne saurait pas faire.
  if (before.isBillable !== after.isBillable) {
    drafts.push({
      field: "isBillable",
      oldValue: String(before.isBillable),
      newValue: String(after.isBillable),
    });
  }

  if (before.invoiceAmount !== after.invoiceAmount) {
    drafts.push({
      field: "invoiceAmount",
      oldValue: before.invoiceAmount,
      newValue: after.invoiceAmount,
    });
  }

  const beforeParts = describeParts(before.partsReplaced);
  const afterParts = describeParts(after.partsReplaced);
  if (beforeParts !== afterParts) {
    drafts.push({
      field: "partsReplaced",
      oldValue: beforeParts,
      newValue: afterParts,
    });
  }

  return drafts;
}

/**
 * La ligne qui consigne un rapport renvoyé au technicien.
 *
 * Elle passe par `field: "status"` plutôt que par un type d'événement à part :
 * la chronologie d'un bon est une seule liste, et le renvoi est ce qui est
 * arrivé à ce bon. Le motif est obligatoire en amont, dans la route — un renvoi
 * sans explication est un technicien qui ne sait pas quoi corriger.
 */
export function rejectionDraft(reason: string): RevisionDraft {
  return {
    field: "status",
    oldValue: "PENDING_APPROVAL",
    newValue: "IN_PROGRESS",
    note: reason,
  };
}

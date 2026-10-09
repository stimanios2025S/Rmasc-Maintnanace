/**
 * Ce qu'un écran de registre lit dans une réponse d'API.
 *
 * POURQUOI CES INTERFACES SONT PARTAGÉES
 * L'écran et la route vivent de part et d'autre d'une frontière HTTP : rien ne
 * les relie à la compilation. Un champ absent de la projection de la route ne
 * casse donc rien — l'écran affiche simplement un tiret, ou « undefined », et
 * cela ressemble à une donnée manquante plutôt qu'à un défaut. C'est le pire
 * genre de bug : il ne se signale pas.
 *
 * Déclarées ici, elles permettent à chaque route de vérifier **à la
 * compilation** que la projection qu'elle envoie porte bien tout ce que l'écran
 * lit. Le contrôle est unidirectionnel, et c'est voulu : une route a le droit de
 * rendre des champs en plus, jamais d'en oublier un.
 *
 * LES DATES Y SONT DES CHAÎNES
 * Ces interfaces décrivent ce qui traverse le réseau, après `JSON.stringify`,
 * et non une ligne de base de données. Un `Date` y serait un mensonge : côté
 * navigateur, c'est une chaîne ISO, et l'écrire autrement laisserait croire
 * qu'un `Date` arrive tout fait.
 *
 * Ce fichier est importé par des composants clients : il ne doit donc rien
 * importer d'autre que des types, et en particulier jamais le client Prisma —
 * la règle qui a fait sortir `metric-catalogue` du module de télémétrie.
 */

import type { InvoiceStatus, InspectionCheckResult, ReportKind } from "@/types";

/**
 * Échoue à la compilation si `T` n'est pas `never`.
 *
 * POURQUOI CETTE FORME ET NON UN TYPE CONDITIONNEL
 * Le réflexe serait d'écrire `type Gap = Exclude<…>; type Check = Gap extends
 * never ? true : Gap;`. **Cela ne vérifie rien.** TypeScript évalue les types
 * conditionnels paresseusement : tant que le résultat n'est pas consommé, un
 * alias qui vaudrait `"clientEmail"` au lieu de `never` reste inerte, et la
 * compilation passe. Une garde qui ne se déclenche jamais est pire qu'aucune
 * garde, parce qu'elle rassure.
 *
 * Une contrainte générique, elle, est vérifiée au moment où l'alias est
 * instancié avec un type concret. `AssertNever<"clientEmail">` échoue
 * immédiatement, avec le nom du champ fautif dans le message.
 *
 * Cette subtilité a été rencontrée en écrivant ce fichier : la première version,
 * conditionnelle, laissait passer un champ absent de la projection Prisma. Elle
 * a été démasquée en ajoutant volontairement un champ fantôme pour voir la garde
 * mordre — elle n'a pas mordu. La forme ci-dessous a été vérifiée de la même
 * façon : la sonde a produit
 * `Type '"clientEmail"' does not satisfy the constraint 'never'`, puis a été
 * retirée.
 */
export type AssertNever<T extends never> = T;

/** Une ligne du registre des factures — `INVOICE_LIST_SELECT` côté route. */
export interface InvoiceRegisterRow {
  id: string;
  number: string;
  /** ISO. Un `Decimal` de Prisma traverse le JSON en chaîne. */
  issuedAt: string;
  amount: string;
  currency: string;
  orderNumber: string;
  orderTitle: string;
  buildingName: string;
  clientId: string | null;
  clientName: string;
  workOrderId: string;
  status: InvoiceStatus;
  /** Null tant que la facture n'a jamais changé d'état. */
  statusChangedAt: string | null;
}

/**
 * Une ligne du registre des rapports — `LIST_SELECT` côté route.
 *
 * Elle ne porte aucun point de contrôle : le registre résume, la fiche détaille.
 * Charger les points ici alourdirait chaque ligne d'un rapport pour une
 * information qu'aucune colonne n'affiche.
 */
export interface InspectionReportRegisterRow {
  id: string;
  reportNumber: string;
  /** La feuille reproduite : une inspection, ou une fiche d'entretien mensuel. */
  kind: ReportKind;
  title: string;
  overallResult: InspectionCheckResult;
  submittedAt: string;
  workOrderId: string;
  technician: { id: string; name: string | null };
  workOrder: { id: string; orderNumber: string };
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string; city: string };
  };
}

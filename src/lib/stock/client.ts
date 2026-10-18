/**
 * Le client du magasin central.
 *
 * MODULE SERVEUR. `node:crypto` y entre, donc rien de ce fichier ne doit être
 * importé par un composant client — la règle est écrite dans `AGENTS.md` du
 * magasin central, et elle vaut dans les deux sens. Les règles pures qui disent
 * *quand* transmettre vivent dans `lib/stock/eligibility.ts`.
 *
 * LA SIGNATURE EST LE CŒUR DE CE FICHIER
 * Le magasin central n'accepte pas un appel authentifié par un cookie : il
 * vérifie une signature HMAC sur trois en-têtes. La chaîne signée est, avec
 * `\n` entre les parties :
 *
 *     <horodatage> \n <MÉTHODE> \n <chemin> \n <corps brut>
 *
 * Trois conséquences, et chacune a déjà coûté du temps à quelqu'un :
 *
 *  1. **L'horodatage est dans la signature.** Un appel capté ne peut donc pas
 *     être rejoué hors de la fenêtre de tolérance (300 secondes). Cela veut
 *     aussi dire qu'une signature ne se réutilise pas : elle se refait à chaque
 *     tentative.
 *  2. **La méthode et le chemin sont dans la signature.** Une signature obtenue
 *     sur la lecture du stock ne peut pas être rejouée sur le dépôt d'une
 *     demande.
 *  3. **Le corps doit être les octets exacts signés.** On sérialise donc une
 *     fois, on signe cette chaîne, et on envoie cette même chaîne. Resérialiser
 *     entre les deux produirait un JSON équivalent et une signature fausse — une
 *     différence d'ordre de clés suffit.
 *
 * La query string n'est délibérément **pas** signée : elle ne porte que des
 * filtres, et les différences d'encodage entre clients HTTP provoqueraient des
 * échecs sans rapport avec la sécurité.
 */

import { createHmac } from "node:crypto";

import type { PartUrgency } from "@/types";

import {
  STOCK_DEMANDE_PATH,
  STOCK_SOURCE_APP,
  stockPriorityFor,
} from "./eligibility";

/** Délai au-delà duquel on considère que le magasin central ne répondra pas. */
const TIMEOUT_MS = 10_000;

interface StockConfig {
  url: string;
  key: string;
  secret: string;
}

/**
 * La configuration, ou `null` tant qu'elle est incomplète.
 *
 * Les trois variables sont lues ensemble : deux sur trois n'est pas une
 * configuration à moitié prête, c'est une configuration qui échoue à la première
 * transmission. Le magasin central refuse une requête dont la clé est inconnue,
 * et le message qu'on recevrait alors ne dirait pas quelle variable manque.
 */
function readConfig(): StockConfig | null {
  /**
   * `process.env.X` écrit en accès littéral, et non `process.env["X"]` : Next.js
   * ne remplace que la première forme à la construction, et un accès dynamique
   * ne serait pas remplacé du tout.
   */
  const url = process.env.STOCK_API_URL?.trim();
  const key = process.env.STOCK_API_KEY?.trim();
  const secret = process.env.STOCK_API_SECRET?.trim();

  if (!url || !key || !secret) return null;

  /**
   * Une barre finale produirait `//api/v1/...` dans le chemin **signé**, alors
   * que le serveur compare le chemin qu'il a reçu. Les deux différeraient d'un
   * caractère et la signature serait refusée sans que rien ne le dise.
   */
  return { url: url.replace(/\/+$/, ""), key, secret };
}

/** Vrai quand les trois variables sont posées. */
export function isStockConfigured(): boolean {
  return readConfig() !== null;
}

/**
 * Ce qu'il faut dire quand ce n'est pas configuré.
 *
 * Le nom des variables est dans le message : « magasin central non configuré »
 * oblige à chercher lesquelles manquent, et c'est exactement ce qu'on ne veut
 * pas faire en installant la liaison.
 */
export function stockConfigRefusal(): string | null {
  if (isStockConfigured()) return null;
  return (
    "Le magasin central n'est pas configuré : STOCK_API_URL, STOCK_API_KEY et " +
    "STOCK_API_SECRET doivent être définies dans .env. Voir .env.example."
  );
}

/** Un article du catalogue du magasin, tel qu'il est proposé au choix. */
export interface StockArticle {
  codeRef: string;
  designation: string;
  unite: string;
  emplacement: string | null;
  location: string;
  quantiteStock: number;
  seuilAlerte: number;
  enAlerte: boolean;
}

/**
 * Le catalogue du magasin, en lecture seule.
 *
 * POURQUOI NOTRE APPLICATION EN A BESOIN
 * Le magasin refuse une ligne de demande sans `codeRef` — 422 constaté sur un
 * échange réel. Nos pièces sont du texte libre et nous n'avons aucun catalogue :
 * le code doit donc être choisi parmi les articles du magasin, et pour choisir
 * il faut les voir.
 *
 * C'EST UNE LECTURE, SIGNÉE COMME LES AUTRES
 * Une requête GET se signe avec un corps vide, et la query string n'entre pas
 * dans la signature.
 */
export async function fetchStockArticles(): Promise<
  { ok: true; articles: StockArticle[] } | { ok: false; error: string }
> {
  const config = readConfig();
  if (!config) return { ok: false, error: stockConfigRefusal()! };

  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = "";

  const signature = buildStockSignature({
    timestamp,
    method: "GET",
    pathname: "/api/v1/external/stock",
    rawBody,
    secret: config.secret,
  });

  try {
    const response = await fetch(`${config.url}/api/v1/external/stock`, {
      method: "GET",
      headers: {
        "x-rmasc-key": config.key,
        "x-rmasc-timestamp": String(timestamp),
        "x-rmasc-signature": signature,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: `Le magasin central a refusé la lecture (${response.status}) : ${text.slice(0, 200)}`,
      };
    }

    const parsed = JSON.parse(text) as { articles?: unknown };
    const raw = Array.isArray(parsed.articles) ? parsed.articles : [];

    /**
     * Ce qui n'a pas de `codeRef` est ignoré : une ligne sans code ne peut pas
     * être commandée, et l'afficher dans le sélecteur offrirait un choix qui
     * échouerait.
     */
    const articles: StockArticle[] = [];
    for (const entry of raw) {
      const item = entry as Record<string, unknown>;
      if (typeof item.codeRef !== "string" || !item.codeRef.trim()) continue;
      if (typeof item.designation !== "string") continue;
      articles.push({
        codeRef: item.codeRef.trim(),
        designation: item.designation,
        unite: typeof item.unite === "string" ? item.unite : "U",
        emplacement:
          typeof item.emplacement === "string" ? item.emplacement : null,
        location: typeof item.location === "string" ? item.location : "",
        quantiteStock:
          typeof item.quantiteStock === "number" ? item.quantiteStock : 0,
        seuilAlerte:
          typeof item.seuilAlerte === "number" ? item.seuilAlerte : 0,
        enAlerte: item.enAlerte === true,
      });
    }

    return { ok: true, articles };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        error: "Le magasin central n'a pas répondu dans le délai imparti (10 s).",
      };
    }
    return {
      ok: false,
      error: `Le magasin central est injoignable : ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * La signature d'une requête. Pure, donc vérifiable sans réseau.
 *
 * Exportée pour être exerçable : c'est la seule partie de ce fichier où une
 * erreur est silencieuse — une signature fausse se manifeste par un refus du
 * magasin central, sans indiquer laquelle des quatre parties diffère.
 */
export function buildStockSignature(params: {
  timestamp: number | string;
  method: string;
  pathname: string;
  rawBody: string;
  secret: string;
}): string {
  const message = [
    String(params.timestamp),
    params.method.toUpperCase(),
    params.pathname,
    params.rawBody,
  ].join("\n");

  return createHmac("sha256", params.secret).update(message, "utf8").digest("hex");
}

/** Une ligne de la demande, telle que le magasin central l'attend. */
interface StockDemandeLine {
  /**
   * Le code d'article du magasin central. **Obligatoire en pratique** : son
   * vérificateur refuse toute ligne sans `codeRef` ni `articleId` — constaté
   * sur un échange réel, 422 « Chaque ligne doit porter « articleId » ou
   * « codeRef » ».
   *
   * Notre application n'a aucun catalogue : le code est choisi par le chef de
   * service technique, sur l'écran magasinier, parmi les articles que le stock
   * expose. Envoyer notre référence de terrain à sa place produirait au mieux
   * une non-correspondance, au pire un rapprochement sur un article qui existe
   * vraiment et ne correspond pas.
   */
  codeRef: string;
  /** La désignation, telle qu'elle sera lue par le magasinier. */
  note: string;
  quantite: number;
}

/** Ce que la route transmet, et rien de plus. */
export interface StockDemandePayload {
  sourceApp: string;
  projet: string;
  priority: string;
  note: string;
  lignes: StockDemandeLine[];
  correlationId: string;
}

/**
 * Compose le corps envoyé au magasin central.
 *
 * PAS DE `demandeurEmail`, ET C'EST DÉLIBÉRÉ
 * Le magasin central refuse une adresse qu'aucun de ses utilisateurs ne porte —
 * sa table n'est pas la nôtre, et nos comptes n'y existent pas. L'appel serait
 * donc rejeté pour une raison qui n'a rien à voir avec la demande. Sa propre
 * variable `EXTERNAL_API_USER_EMAIL` l'attribue à son compte technique, et le
 * nom du demandeur part dans `note` : la traçabilité est conservée là où elle
 * est lisible, au lieu d'être perdue dans un champ refusé.
 *
 * `correlationId` PORTE NOTRE NUMÉRO
 * C'est la seule chose qui relie une demande du magasin à la nôtre. Il est
 * enregistré des deux côtés, ce qui permet de répondre à « où en est
 * DP-202609-7KQ4ZP ? » sans comparer des désignations saisies à la main.
 */
export function buildStockDemande(params: {
  requirementNumber: string;
  urgency: PartUrgency;
  quantity: number;
  replacementPartName: string;
  replacementPartReference?: string | null;
  faultyPartName: string;
  notes?: string | null;
  elevatorCode: string;
  buildingName: string;
  buildingCity?: string | null;
  workOrderNumber: string;
  requestedByName?: string | null;
  /**
   * Le code d'article choisi dans le catalogue du magasin. Obligatoire : le
   * stock refuse une ligne qui n'en porte pas (422, constaté en conditions
   * réelles). Le rendre obligatoire ici fait échouer la compilation plutôt que
   * la transmission, ce qui est le bon endroit pour s'en apercevoir.
   */
  stockCodeRef: string;
}): StockDemandePayload {
  const site = params.buildingCity
    ? `${params.buildingName} — ${params.buildingCity}`
    : params.buildingName;

  const designation = params.replacementPartReference
    ? `${params.replacementPartName} (réf. ${params.replacementPartReference})`
    : params.replacementPartName;

  const context = [
    `Bon ${params.workOrderNumber}`,
    `ascenseur ${params.elevatorCode}`,
    `pièce en panne : ${params.faultyPartName}`,
    params.requestedByName ? `demandé par ${params.requestedByName}` : null,
    params.notes?.trim() ? `observations : ${params.notes.trim()}` : null,
  ].filter(Boolean);

  return {
    sourceApp: STOCK_SOURCE_APP,
    projet: site,
    priority: stockPriorityFor(params.urgency),
    note: `${params.requirementNumber} — ${context.join(" · ")}`,
    lignes: [
      {
        codeRef: params.stockCodeRef,
        note: designation,
        quantite: params.quantity,
      },
    ],
    correlationId: params.requirementNumber,
  };
}

export type TransmitResult =
  | {
      ok: true;
      demandeId: string | null;
      reference: string | null;
      status: string | null;
    }
  | { ok: false; error: string };

/**
 * Dépose la demande auprès du magasin central.
 *
 * NE LÈVE PAS : rend un résultat. Une transmission qui échoue est un état normal
 * de l'exploitation — le magasin central redémarre, le réseau tombe — et
 * l'appelant doit pouvoir l'enregistrer sans que la route rende une erreur 500.
 *
 * LA SIGNATURE EST REFaite ICI, À CHAQUE APPEL
 * L'horodatage fait partie du message signé : réutiliser une signature calculée
 * plus haut la ferait expirer. Il n'y a donc pas de cache, et c'est voulu.
 */
export async function transmitDemande(
  payload: StockDemandePayload
): Promise<TransmitResult> {
  const config = readConfig();
  if (!config) return { ok: false, error: stockConfigRefusal()! };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = buildStockSignature({
    timestamp,
    method: "POST",
    pathname: STOCK_DEMANDE_PATH,
    rawBody: body,
    secret: config.secret,
  });

  try {
    const response = await fetch(`${config.url}${STOCK_DEMANDE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rmasc-key": config.key,
        "x-rmasc-timestamp": String(timestamp),
        "x-rmasc-signature": signature,
        /**
         * La clé d'idempotence est notre propre numéro de demande. Un second
         * envoi après un délai d'attente ne crée donc pas une seconde demande :
         * le magasin central rend le résultat du premier. Sans elle, un
         * `fetch` qui expire produirait deux commandes pour une seule pièce.
         */
        "Idempotency-Key": payload.correlationId,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await response.text();

    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      /**
       * Le magasin central nomme le champ fautif et les valeurs admises. Les
       * recopier tels quels vaut mieux qu'un message générique : c'est le seul
       * endroit où l'on apprend *pourquoi* il a refusé.
       */
      const detail =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : text.slice(0, 300) || `HTTP ${response.status}`;
      return {
        ok: false,
        error: `Le magasin central a refusé la demande (${response.status}) : ${detail}`,
      };
    }

    const data = (parsed ?? {}) as {
      demandeId?: unknown;
      reference?: unknown;
      status?: unknown;
    };

    return {
      ok: true,
      demandeId: typeof data.demandeId === "string" ? data.demandeId : null,
      reference: typeof data.reference === "string" ? data.reference : null,
      status: typeof data.status === "string" ? data.status : null,
    };
  } catch (error) {
    /**
     * `AbortSignal.timeout` rejette avec un `TimeoutError` : le dire clairement,
     * parce que « fetch failed » envoie chercher une panne réseau là où le
     * magasin central est simplement lent.
     */
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        error:
          "Le magasin central n'a pas répondu dans le délai imparti (10 s). " +
          "La demande n'a pas été transmise — réessayez.",
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Le magasin central est injoignable : ${message}`,
    };
  }
}

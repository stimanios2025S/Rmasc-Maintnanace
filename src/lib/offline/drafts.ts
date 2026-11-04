/**
 * Brouillons hors-ligne du technicien.
 *
 * POURQUOI CE MODULE
 * Un technicien travaille en sous-sol, dans une cage d'ascenseur ou dans un
 * local technique sans réseau. La check-list, les notes et les photos qu'il y
 * saisit ont plus de valeur que le formulaire qui les recueille : si un
 * rechargement de page ou une coupure les efface, il refait le tour du site
 * pour retrouver des constats qu'il avait déjà faits. Ces saisies sont donc
 * écrites sur l'appareil à chaque frappe, et relues au chargement.
 *
 * CE QUE CE N'EST PAS
 * Un cache de l'application ni une base locale du métier. Le brouillon ne
 * contient que ce que l'utilisateur a tapé et qui n'a pas encore été envoyé ;
 * il est effacé dès que le rapport part. Les faits validés vivent en base, et
 * deux sources de vérité divergeraient dès la première reprise.
 *
 * `localStorage` et non IndexedDB : les objets tenus ici font quelques
 * kilo-octets (des libellés, des résultats, des URL de photos), une API
 * synchrone suffit, et la compatibilité est plus large sur les téléphones
 * anciens que le parc contient. Une URL de photo est stockée, pas l'image —
 * le fichier vit déjà ailleurs.
 *
 * Le stockage peut échouer (navigation privée, quota plein, politique
 * d'entreprise) : chaque accès est protégé et l'échec est silencieux. Un
 * brouillon qui ne se sauvegarde pas ne doit pas empêcher de travailler.
 */

const PREFIX = "rmasc:tech-draft:v1";

export interface TechnicianDraft {
  /** Résultat par ligne de check-list, dans l'ordre de la liste du bon. */
  checklist?: Array<string | null>;
  /** Notes libres du bon, telles que tapées. */
  notes?: string;
  /** index de ligne → URL de la photo justificative. */
  photos?: Record<number, string>;
  /** La note d'arrivée, saisie avant le pointage. */
  arrivalNote?: string;
  /** La signature capturée, au format rendu par `SignaturePad`. */
  signature?: unknown;
  /** Le rapport de fin en cours de rédaction. */
  report?: {
    description: string;
    parts: Array<{ name: string; partNumber: string; qty: string }>;
    isBillable: boolean;
    amount: string;
  };
  updatedAt: string;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function keyFor(jobId: string): string {
  return `${PREFIX}:${jobId}`;
}

export function readDraft(jobId: string): TechnicianDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(keyFor(jobId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as TechnicianDraft)
      : null;
  } catch {
    return null;
  }
}

/** Fusionne un correctif dans le brouillon existant et l'écrit. */
export function saveDraft(
  jobId: string,
  patch: Partial<TechnicianDraft>
): void {
  const store = storage();
  if (!store) return;
  try {
    const current = readDraft(jobId) ?? {};
    store.setItem(
      keyFor(jobId),
      JSON.stringify({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    // Quota plein, navigation privée : la saisie reste à l'écran.
  }
}

/** À appeler quand le rapport est parti : plus rien à rejouer. */
export function clearDraft(jobId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(jobId));
  } catch {
    // Ignoré : un brouillon orphelin sera écrasé au prochain passage.
  }
}

/**
 * Retire les brouillons des bons qui ne sont plus dans la file.
 *
 * Sans ce ménage, un téléphone partagé accumule indéfiniment les saisies de
 * tous les techniciens qui l'ont utilisé, longtemps après la clôture des bons.
 */
export function pruneDrafts(liveJobIds: string[]): void {
  const store = storage();
  if (!store) return;
  const live = new Set(liveJobIds);
  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (!key?.startsWith(`${PREFIX}:`)) continue;
      const jobId = key.slice(PREFIX.length + 1);
      if (!live.has(jobId)) store.removeItem(key);
    }
  } catch {
    // Ignoré : le ménage est une commodité, pas une garantie.
  }
}

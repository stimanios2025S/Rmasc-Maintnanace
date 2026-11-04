/**
 * File d'attente des écritures de terrain.
 *
 * POURQUOI CE MODULE
 * Le pointage d'arrivée et l'envoi du rapport sont les deux gestes qu'un
 * technicien fait *sur place*, souvent là où il n'a pas de réseau. Jusqu'ici
 * un échec réseau affichait une erreur et l'action était perdue : il fallait
 * redescendre, retrouver du réseau et refaire le geste. Ces deux écritures sont
 * donc mises en file sur l'appareil quand la connexion manque, puis rejouées
 * automatiquement au retour du réseau.
 *
 * CE QUI ENTRE DANS LA FILE, ET CE QUI N'Y ENTRE PAS
 * Seulement les écritures que l'utilisateur a explicitement déclenchées — il a
 * appuyé sur un bouton, l'intention existe. Rien n'est inventé ici. Un refus
 * du serveur (400, 403) est retiré de la file : réessayer ne le changera pas,
 * et le garder ferait croire à une sauvegarde en attente qui n'arrivera jamais.
 * Seuls les échecs transitoires — réseau coupé, 5xx — restent en attente.
 *
 * L'ORDRE EST CELUI DE LA FILE
 * Un pointage d'arrivée doit précéder la fin d'intervention, qui doit précéder
 * le rapport. Les entrées sont rejouées dans l'ordre d'insertion ; au premier
 * échec réseau on s'arrête, sans quoi le rapport d'un bon serait envoyé avant
 * l'arrivée qui le rend légitime.
 *
 * UN DOUBLON N'EST PAS UNE PERTE
 * `POST /check-in` et `POST /check-out` sont idempotents côté serveur (409
 * portant la première heure). Le dépôt d'un rapport en double reçoit un 409
 * « un rapport existe déjà » : dans les deux cas le rejeu aboutit à l'état
 * voulu, et l'entrée est retirée de la file.
 */

const KEY = "rmasc:tech-outbox:v1";

export interface OutboxInspection {
  workOrderId: string;
  kind: string;
  summary: string;
  items: Array<{
    checkName: string;
    result: string;
    photoUrl?: string;
  }>;
  signatures?: unknown[];
}

export type OutboxItem =
  | {
      id: string;
      kind: "check-in";
      workOrderId: string;
      body: Record<string, unknown>;
      label: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "check-out";
      workOrderId: string;
      label: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "completion";
      workOrderId: string;
      inspection: OutboxInspection | null;
      order: Record<string, unknown>;
      label: string;
      createdAt: string;
    };

export interface FlushResult {
  sent: number;
  remaining: number;
  /** Refus définitifs, formulés pour être lus par le technicien. */
  failures: string[];
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readOutbox(): OutboxItem[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (items.length === 0) store.removeItem(KEY);
    else store.setItem(KEY, JSON.stringify(items));
  } catch {
    // Quota plein : la file est perdue, mais l'écran le dit déjà.
  }
}

export function outboxCount(): number {
  return readOutbox().length;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ajoute une écriture, en remplaçant celle qui viserait le même geste sur le
 * même bon. Un double appui hors-ligne ne doit pas produire deux rapports.
 */
export function enqueue(
  item:
    | Omit<Extract<OutboxItem, { kind: "check-in" }>, "id" | "createdAt">
    | Omit<Extract<OutboxItem, { kind: "check-out" }>, "id" | "createdAt">
    | Omit<Extract<OutboxItem, { kind: "completion" }>, "id" | "createdAt">
): OutboxItem {
  const entry = {
    ...item,
    id: newId(),
    createdAt: new Date().toISOString(),
  } as OutboxItem;

  const remaining = readOutbox().filter(
    (queued) =>
      !(queued.kind === entry.kind && queued.workOrderId === entry.workOrderId)
  );
  writeOutbox([...remaining, entry]);
  return entry;
}

function replaceItem(next: OutboxItem): void {
  writeOutbox(
    readOutbox().map((item) => (item.id === next.id ? next : item))
  );
}

function removeItem(id: string): void {
  writeOutbox(readOutbox().filter((item) => item.id !== id));
}

/** Un échec réseau, et non un refus du serveur. */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

async function sendJson(
  url: string,
  method: string,
  body?: unknown
): Promise<Response> {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Verdict = "done" | "retry" | "rejected";

async function messageOf(res: Response): Promise<string> {
  const payload = await res.json().catch(() => null);
  const message = payload?.error ?? payload?.message;
  if (typeof message === "string") return message;
  if (message && typeof message.message === "string") return message.message;
  return `Le serveur a répondu ${res.status}.`;
}

async function deliver(item: OutboxItem): Promise<{
  verdict: Verdict;
  message?: string;
}> {
  if (item.kind === "check-in") {
    const res = await sendJson(
      `/api/work-orders/${item.workOrderId}/check-in`,
      "POST",
      item.body
    );
    // 409 : l'arrivée est déjà enregistrée — c'est le résultat voulu.
    if (res.ok || res.status === 409) return { verdict: "done" };
    if (res.status >= 400 && res.status < 500) {
      return { verdict: "rejected", message: await messageOf(res) };
    }
    return { verdict: "retry" };
  }

  if (item.kind === "check-out") {
    const res = await sendJson(
      `/api/work-orders/${item.workOrderId}/check-out`,
      "POST"
    );
    if (res.ok || res.status === 409) return { verdict: "done" };
    if (res.status >= 400 && res.status < 500) {
      return { verdict: "rejected", message: await messageOf(res) };
    }
    return { verdict: "retry" };
  }

  /**
   * Rapport de fin : deux écritures, dans l'ordre du serveur — la preuve
   * d'abord, puis la remise au bureau. Un 409 sur le rapport signifie qu'il a
   * déjà été déposé (rejeu après une réponse perdue) ; on continue vers la
   * bascule de statut plutôt que de bloquer la file.
   */
  if (item.inspection) {
    const res = await sendJson(
      "/api/inspection-reports",
      "POST",
      item.inspection
    );
    if (!res.ok && res.status !== 409) {
      if (res.status >= 400 && res.status < 500) {
        return { verdict: "rejected", message: await messageOf(res) };
      }
      return { verdict: "retry" };
    }
    // Le rapport est déposé : le retirer de l'entrée évite de le redéposer si
    // la bascule de statut échoue à son tour.
    replaceItem({ ...item, inspection: null });
  }

  const res = await sendJson(
    `/api/work-orders?id=${encodeURIComponent(item.workOrderId)}`,
    "PATCH",
    item.order
  );
  if (res.ok || res.status === 409) return { verdict: "done" };
  if (res.status >= 400 && res.status < 500) {
    return { verdict: "rejected", message: await messageOf(res) };
  }
  return { verdict: "retry" };
}

/**
 * Rejoue la file. À appeler quand le navigateur repasse en ligne.
 *
 * S'arrête au premier échec transitoire : les écritures suivantes dépendent de
 * celle qui vient d'échouer.
 */
export async function flushOutbox(): Promise<FlushResult> {
  const failures: string[] = [];
  let sent = 0;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const remaining = readOutbox().length;
    return { sent, remaining, failures };
  }

  let queue = readOutbox();

  for (const item of [...queue]) {
    try {
      const { verdict, message } = await deliver(item);

      if (verdict === "retry") break;
      if (verdict === "rejected") {
        failures.push(`${item.label} : ${message ?? "refusé par le serveur"}`);
      }

      removeItem(item.id);
      sent += 1;
      queue = readOutbox();
    } catch (error) {
      if (isNetworkError(error)) break;
      // Une exception de programmation ne doit pas boucler indéfiniment sur
      // une entrée impossible : on la retire et on la signale.
      removeItem(item.id);
      failures.push(
        `${item.label} : ${
          error instanceof Error ? error.message : "échec inconnu"
        }`
      );
      queue = readOutbox();
    }
  }

  return { sent, remaining: queue.length, failures };
}

/** Vrai quand l'échec vient de la connexion, et non d'un refus. */
export function isConnectivityFailure(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

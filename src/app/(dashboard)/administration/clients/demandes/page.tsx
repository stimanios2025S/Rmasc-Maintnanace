"use client";

/**
 * Le registre des demandes d'accès déposées depuis les QR.
 *
 * CE QUE CET ÉCRAN DÉCIDE
 * Une demande déposée sur la page publique n'ouvre rien : elle attend ici. Le
 * bouton « Approuver & créer le compte » est le seul chemin par lequel un
 * scanner de QR devient un compte client — il engendre le mot de passe, crée
 * le compte, rattache l'immeuble de l'appareil s'il est libre, et marque la
 * demande traitée. « Refuser » ne crée rien et ne fait que statuer.
 *
 * POURQUOI LA DEMANDE EST LUE ENTIÈRE
 * L'administrateur qui décide doit voir *qui* demande, pour *quel appareil*, et
 * avec quel rôle déclaré. Un identifiant et un bouton ne permettent pas de
 * décider ; c'est une personne au téléphone qui a scanné une plaque.
 *
 * L'INVITATION N'EST PAS UNE CONDITION
 * Le compte est créé avant l'envoi. Si le WhatsApp ne part pas — instance non
 * configurée, numéro absent —, l'écran le dit et propose le courriel préparé.
 * Le mot de passe reste affiché une fois : il est la seule copie en clair.
 */

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  Check,
  Mail,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { CredentialsPanel } from "@/components/admin/credentials-panel";

type AccessRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

interface AccessRequestRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  role: string;
  message: string | null;
  status: AccessRequestStatus;
  decidedAt: string | null;
  createdAt: string;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string; city: string };
  };
  decidedBy: { id: string; name: string } | null;
  createdUser: { id: string; name: string; email: string } | null;
}

interface ApprovalResult {
  email: string;
  password: string;
  buildingAttached: boolean;
  buildingName: string;
  whatsapp: { delivered: boolean; reason?: string };
  mailto: string;
}

const STATUS_LABELS: Record<AccessRequestStatus, string> = {
  PENDING: "En attente",
  APPROVED: "Approuvée",
  REJECTED: "Refusée",
};

const STATUS_STYLES: Record<AccessRequestStatus, string> = {
  PENDING:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  APPROVED:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  REJECTED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const FILTERS: { value: "" | AccessRequestStatus; label: string }[] = [
  { value: "PENDING", label: "En attente" },
  { value: "", label: "Toutes" },
  { value: "APPROVED", label: "Approuvées" },
  { value: "REJECTED", label: "Refusées" },
];

function formatDay(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "d MMM yyyy 'à' HH:mm", { locale: fr });
}

/** Ce que dit une invitation WhatsApp qui n'est pas partie, en français. */
const WHATSAPP_REASONS: Record<string, string> = {
  "no-transport": "instance WhatsApp non configurée",
  "no-recipient": "aucun numéro enregistré",
  "bad-number": "numéro inutilisable",
  "transport-error": "instance injoignable",
  rejected: "message refusé par WhatsApp",
};

export default function AccessRequestsPage() {
  const [status, setStatus] = useState<"" | AccessRequestStatus>("PENDING");
  const [rows, setRows] = useState<AccessRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalResult | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = status ? `?status=${status}` : "";
      const response = await fetch(`/api/access-requests${query}`);
      if (!response.ok) {
        throw new Error(`Le registre a répondu ${response.status}.`);
      }
      const payload = await response.json();
      setRows(Array.isArray(payload?.data) ? payload.data : []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Impossible de charger les demandes d'accès."
      );
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: AccessRequestRow, action: "APPROVE" | "REJECT") {
    if (
      action === "REJECT" &&
      !window.confirm(
        `Refuser la demande de ${row.firstName} ${row.lastName} ? Aucun compte ne sera créé.`
      )
    ) {
      return;
    }

    setBusyId(row.id);
    setNotice("");
    try {
      const response = await fetch(`/api/access-requests/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La décision a échoué (${response.status}).`);
      }

      if (action === "APPROVE") {
        setApproval({
          email: payload.data.client.email,
          password: payload.data.password,
          buildingAttached: payload.data.buildingAttached,
          buildingName: payload.data.buildingName,
          whatsapp: payload.data.invitation.whatsapp,
          mailto: payload.data.invitation.mailto,
        });
        setNotice(
          payload.data.buildingAttached
            ? `Compte créé et immeuble « ${payload.data.buildingName} » rattaché.`
            : `Compte créé. L'immeuble « ${payload.data.buildingName} » était déjà ` +
                "rattaché à un autre compte : il n'a pas été transféré."
        );
      } else {
        setNotice(`Demande de ${row.firstName} ${row.lastName} refusée.`);
      }

      await load();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "La décision a échoué."
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Demandes d&apos;accès
          </h2>
          <p className="mt-1 text-gray-500">
            Les demandes déposées en scannant le QR d&apos;un appareil. Approuver
            ouvre le compte client ; rien n&apos;est ouvert avant.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              onClick={() => setStatus(filter.value)}
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                status === filter.value
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {filter.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Actualiser
          </button>
        </div>
      </div>

      {approval && (
        <div className="space-y-3">
          <CredentialsPanel
            email={approval.email}
            password={approval.password}
            subject="client"
            onDismiss={() => setApproval(null)}
          />
          <Card className="p-4">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              Invitation
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {approval.whatsapp.delivered
                ? "Le message WhatsApp a été accepté par le service d'envoi."
                : `WhatsApp non envoyé (${
                    WHATSAPP_REASONS[approval.whatsapp.reason ?? ""] ??
                    "raison inconnue"
                  }).`}{" "}
              Le compte existe dans tous les cas.
            </p>
            <a
              href={approval.mailto}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              Envoyer par e-mail
            </a>
          </Card>
        </div>
      )}

      {notice && (
        <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          {notice}
        </p>
      )}

      {loading ? (
        <LoadingSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucune demande dans ce filtre"
          hint="Une demande apparaît ici dès qu'une personne scanne le QR d'un appareil et remplit le formulaire."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id} className="p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-gray-900 dark:text-white">
                      {row.firstName} {row.lastName}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        STATUS_STYLES[row.status]
                      }`}
                    >
                      {STATUS_LABELS[row.status]}
                    </span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      {row.role}
                    </span>
                  </div>

                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    {row.phone} · {row.email}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Appareil{" "}
                    <span className="font-mono">{row.elevator.elevatorCode}</span>{" "}
                    — {row.elevator.building.name}, {row.elevator.building.city}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Demande du {formatDay(row.createdAt)}
                    {row.decidedAt && ` · traitée le ${formatDay(row.decidedAt)}`}
                    {row.decidedBy && ` par ${row.decidedBy.name}`}
                  </p>
                  {row.message && (
                    <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      {row.message}
                    </p>
                  )}
                </div>

                {row.status === "PENDING" && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row, "APPROVE")}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      Approuver &amp; créer le compte
                    </button>
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => void decide(row, "REJECT")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                      Refuser
                    </button>
                  </div>
                )}

                {row.status === "APPROVED" && row.createdUser && (
                  <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    Compte créé : {row.createdUser.email}
                  </p>
                )}

                {row.status === "PENDING" && (
                  <span className="hidden items-center gap-1.5 text-xs text-gray-400 lg:flex">
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    Décision du bureau
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

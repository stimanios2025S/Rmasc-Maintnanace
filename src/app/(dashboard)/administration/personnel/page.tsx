"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  CirclePause,
  CirclePlay,
  CircleX,
  KeyRound,
  Loader2,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { CredentialsPanel } from "@/components/admin/credentials-panel";
import { enumLabel } from "@/lib/ui/enum-labels";
import {
  SETTABLE_TECHNICIAN_STATUSES,
  STAFF_ROLES,
  TECHNICIAN_SKILLS,
} from "@/types";
import type {
  StaffRole,
  TechnicianSkill,
  TechnicianStatus,
} from "@/types";

/**
 * La gestion du personnel — embaucher, corriger une fiche, rendre un accès.
 *
 * POURQUOI CET ÉCRAN EXISTE
 * Jusqu'ici, la seule façon d'ouvrir un compte de salarié était de lancer le
 * script de peuplement ou d'écrire en base. Une entreprise ne peut pas
 * embaucher comme ça : un recrutement demandait une intervention technique sur
 * le serveur, ce qui est à la fois une dépendance et un risque.
 *
 * CE QU'IL NE FAIT PAS
 * Il ne supprime pas. Un salarié qui part garde ses interventions, ses rapports
 * signés et les factures qu'il a émises ; effacer la ligne les laisserait
 * orphelins ou refuserait l'écriture. `isActive` ferme l'accès sans réécrire
 * l'historique, et l'écran dit « inactif » plutôt que de faire disparaître
 * quelqu'un qui a travaillé ici.
 *
 * CE QU'IL NE LAISSE PAS CHOISIR
 * L'état « en intervention » n'est pas dans le sélecteur : il est calculé à
 * partir des affectations réelles du technicien. Le proposer permettrait de
 * déclarer en intervention quelqu'un qui est chez lui, et le calcul le
 * réécrirait de toute façon à la prochaine affectation.
 */

interface StaffMember {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: StaffRole;
  status: TechnicianStatus;
  isActive: boolean;
  specialties: TechnicianSkill[];
  defaultZone: string | null;
  createdAt: string;
  lastPositionAt: string | null;
  _count: { assignedWorkOrders: number; assignedIncidents: number };
}

/**
 * Les filtres d'état, tels qu'un responsable les pense.
 *
 * Chacun correspond à une requête différente — certains filtrent sur l'activité
 * du compte, d'autres sur la disponibilité — mais l'écran n'en présente qu'une
 * seule dimension, celle du mot qu'on emploie en parlant. Un compte inactif dont
 * l'état est « en congé » apparaît sous les deux : les deux affirmations sont
 * vraies, et il n'y a pas de raison de choisir laquelle taire.
 */
type StateFilter =
  | "all"
  | "active"
  | "on-job"
  | "on-leave"
  | "off-duty"
  | "inactive";

const STATE_FILTERS: {
  key: StateFilter;
  label: string;
  query: (params: URLSearchParams) => void;
}[] = [
  { key: "all", label: "Tous", query: () => undefined },
  {
    key: "active",
    label: "Actifs",
    query: (p) => p.set("active", "true"),
  },
  {
    key: "on-job",
    label: "En intervention",
    query: (p) => p.set("status", "ON_JOB"),
  },
  {
    key: "on-leave",
    label: "En congé",
    query: (p) => p.set("status", "ON_LEAVE"),
  },
  {
    key: "off-duty",
    label: "Hors service",
    query: (p) => p.set("status", "OFF_DUTY"),
  },
  {
    key: "inactive",
    label: "Inactifs",
    query: (p) => p.set("active", "false"),
  },
];

const STATUS_STYLES: Record<TechnicianStatus, string> = {
  AVAILABLE:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  ON_JOB: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ON_LEAVE:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  OFF_DUTY: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const ROLE_STYLES: Record<StaffRole, string> = {
  ADMIN: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  MAINTENANCE_MANAGER:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  FIELD_TECHNICIAN:
    "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300",
};

interface FormState {
  name: string;
  email: string;
  phone: string;
  role: StaffRole;
  status: TechnicianStatus;
  specialties: TechnicianSkill[];
  defaultZone: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    email: "",
    phone: "",
    role: "FIELD_TECHNICIAN",
    status: "AVAILABLE",
    specialties: [],
    defaultZone: "",
  };
}

function formOf(member: StaffMember): FormState {
  return {
    name: member.name,
    email: member.email,
    phone: member.phone ?? "",
    role: member.role,
    status: member.status,
    specialties: member.specialties,
    defaultZone: member.defaultZone ?? "",
  };
}

export default function PersonnelPage() {
  const { data: session } = useSession();
  const selfId = session?.user?.id;

  const [members, setMembers] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const [role, setRole] = useState<StaffRole | "ALL">("ALL");
  const [state, setState] = useState<StateFilter>("all");
  const [query, setQuery] = useState("");
  /** Ce qui a réellement été envoyé au serveur, pour ne pas mentir sur le filtre. */
  const [appliedQuery, setAppliedQuery] = useState("");

  /** `null` = fermé ; `""` = création ; un id = édition de cette fiche. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Le mot de passe engendré, montré une fois puis oublié. */
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(
    null
  );

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");

      const params = new URLSearchParams();
      if (role !== "ALL") params.set("role", role);
      STATE_FILTERS.find((f) => f.key === state)?.query(params);
      if (appliedQuery) params.set("q", appliedQuery);

      try {
        const res = await fetch(`/api/personnel?${params.toString()}`);
        if (!res.ok) throw new Error(`L'API du personnel a répondu ${res.status}`);
        const json = await res.json();
        setMembers(Array.isArray(json.data?.members) ? json.data.members : []);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement de l'équipe"
        );
      } finally {
        setLoading(false);
      }
    },
    [role, state, appliedQuery]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: members.length,
      inactive: members.filter((m) => !m.isActive).length,
    }),
    [members]
  );

  function closeForm() {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
  }

  function openCreate() {
    setEditing("");
    setForm(emptyForm());
    setFormError(null);
    setActionError(null);
  }

  function openEdit(member: StaffMember) {
    setEditing(member.id);
    setForm(formOf(member));
    setFormError(null);
    setActionError(null);
  }

  async function save() {
    const name = form.name.trim();
    if (name.length < 2) {
      setFormError("Renseignez le nom complet.");
      return;
    }
    if (!form.email.trim()) {
      setFormError("Renseignez l'adresse e-mail.");
      return;
    }

    const isCreate = editing === "";
    const isTechnician = form.role === "FIELD_TECHNICIAN";

    const payload: Record<string, unknown> = {
      name,
      email: form.email.trim(),
      phone: form.phone.trim(),
      role: form.role,
      specialties: isTechnician ? form.specialties : [],
      defaultZone: isTechnician ? form.defaultZone.trim() : "",
    };

    // L'état ne se pose que sur un technicien : un compte de bureau n'a pas de
    // disponibilité qui veuille dire quelque chose.
    if (isTechnician) payload.status = form.status;

    setSaving(true);
    setFormError(null);

    try {
      const res = await fetch(
        isCreate ? "/api/personnel" : `/api/personnel/${editing}`,
        {
          method: isCreate ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "L'enregistrement a été refusé."
        );
      }

      // Le mot de passe n'est rendu qu'à la création, et une seule fois.
      if (isCreate && body.data?.password) {
        setIssued({ email: name, password: body.data.password });
      }

      closeForm();
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "L'enregistrement a échoué.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(member: StaffMember) {
    setBusyId(member.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/personnel/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !member.isActive }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? body?.message ?? "La mise à jour a échoué.");
      }
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "La mise à jour a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  async function regenerate(member: StaffMember) {
    setBusyId(member.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/personnel/${member.id}/password`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "La régénération a été refusée."
        );
      }
      setIssued({ email: member.email, password: body.data.password });
      await load({ silent: true });
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "La régénération a échoué."
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading && members.length === 0) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && members.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      {issued && (
        <CredentialsPanel
          email={issued.email}
          password={issued.password}
          subject="salarié"
          regenerateFrom="sa fiche, ci-dessous"
          onDismiss={() => setIssued(null)}
        />
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Équipe
            </h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {counts.total} compte{counts.total > 1 ? "s" : ""}
              {counts.inactive > 0
                ? ` · dont ${counts.inactive} inactif${counts.inactive > 1 ? "s" : ""}`
                : ""}
            </p>
          </div>

          {editing === null && (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Nouveau salarié
            </button>
          )}
        </div>

        {/* ── Recherche ──────────────────────────────────────── */}
        <form
          className="mt-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQuery(query.trim());
          }}
        >
          <div className="relative flex-1 min-w-[240px]">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nom ou adresse e-mail"
              aria-label="Rechercher un membre de l'équipe"
              className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Rechercher
          </button>
          {appliedQuery && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setAppliedQuery("");
              }}
              className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              Effacer
            </button>
          )}
        </form>

        {/* ── Filtres ────────────────────────────────────────── */}
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Rôle
            </span>
            <div role="tablist" aria-label="Filtrer par rôle" className="flex flex-wrap gap-1.5">
              <FilterChip
                active={role === "ALL"}
                onClick={() => setRole("ALL")}
                label="Tous"
              />
              {STAFF_ROLES.map((r) => (
                <FilterChip
                  key={r}
                  active={role === r}
                  onClick={() => setRole(r)}
                  label={enumLabel(r)}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              État
            </span>
            <div role="tablist" aria-label="Filtrer par état" className="flex flex-wrap gap-1.5">
              {STATE_FILTERS.map((option) => (
                <FilterChip
                  key={option.key}
                  active={state === option.key}
                  onClick={() => setState(option.key)}
                  label={option.label}
                />
              ))}
            </div>
          </div>
        </div>

        {actionError && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {actionError}
          </p>
        )}
      </Card>

      {/* ── Formulaire ───────────────────────────────────────── */}
      {editing !== null && (
        <StaffForm
          editing={editing}
          form={form}
          setForm={setForm}
          error={formError}
          saving={saving}
          onSave={save}
          onCancel={closeForm}
        />
      )}

      {/* ── Liste ────────────────────────────────────────────── */}
      {members.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            title="Aucun compte dans ce filtre"
            hint="Changez de rôle ou d'état, ou ouvrez un compte avec « Nouveau salarié »."
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {members.map((member) => {
            const isSelf = member.id === selfId;
            const isBusy = busyId === member.id;
            const workload =
              member._count.assignedWorkOrders + member._count.assignedIncidents;

            return (
              <li key={member.id}>
                <Card
                  className={`p-4 ${member.isActive ? "" : "border-dashed opacity-75"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {member.name}
                    </span>
                    {isSelf && (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        Vous
                      </span>
                    )}

                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${ROLE_STYLES[member.role]}`}
                    >
                      {enumLabel(member.role)}
                    </span>

                    {member.isActive ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[member.status]}`}
                      >
                        {enumLabel(member.status)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        <CircleX className="h-3 w-3" aria-hidden="true" />
                        Compte inactif
                      </span>
                    )}

                    {member.role === "FIELD_TECHNICIAN" && member.isActive && (
                      <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                        {workload} en cours
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
                    <span className="inline-flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                      {member.email}
                    </span>
                    {member.phone ? (
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                        <Phone className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                        {member.phone}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        Aucun mobile — ce salarié ne recevra pas ses bons par WhatsApp.
                      </span>
                    )}
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Depuis le{" "}
                      {format(new Date(member.createdAt), "d MMMM yyyy", {
                        locale: fr,
                      })}
                    </span>
                  </div>

                  {member.role === "FIELD_TECHNICIAN" && (
                    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      {member.specialties.length > 0 ? (
                        member.specialties.map((skill) => (
                          <span
                            key={skill}
                            className="rounded-full border border-gray-300 px-2 py-0.5 text-gray-600 dark:border-gray-700 dark:text-gray-300"
                          >
                            {enumLabel(skill)}
                          </span>
                        ))
                      ) : (
                        <span className="text-gray-500 dark:text-gray-400">
                          Aucune compétence déclarée.
                        </span>
                      )}
                      {member.defaultZone && (
                        <span className="text-gray-500 dark:text-gray-400">
                          · secteur {member.defaultZone}
                        </span>
                      )}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openEdit(member)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      Modifier
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void regenerate(member)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      {isBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      Régénérer l&apos;accès
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void toggleActive(member)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                    >
                      {member.isActive ? (
                        <CirclePause className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <CirclePlay className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {member.isActive ? "Désactiver" : "Réactiver"}
                    </button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Card className="p-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Régénérer un accès ferme immédiatement les sessions ouvertes du
          salarié, sur tous ses appareils. Désactiver un compte fait de même et
          lui retire l&apos;application, sans effacer ses interventions passées
          ni les factures qu&apos;il a émises.
        </p>
      </Card>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-blue-600 text-white"
          : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * La fiche, en création comme en édition.
 *
 * Les trois champs de technicien — compétences, secteur, disponibilité — ne
 * s'affichent que pour un rôle de terrain. Les montrer sur un compte
 * d'administration laisserait croire qu'ils veulent dire quelque chose, alors
 * qu'aucun écran de répartition ne les lira pour un poste de bureau.
 */
function StaffForm({
  editing,
  form,
  setForm,
  error,
  saving,
  onSave,
  onCancel,
}: {
  editing: string;
  form: FormState;
  setForm: (next: FormState) => void;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isCreate = editing === "";
  const isTechnician = form.role === "FIELD_TECHNICIAN";

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          {isCreate ? "Nouveau salarié" : "Modifier la fiche"}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer le formulaire"
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
            Nom complet
          </span>
          <input
            type="text"
            value={form.name}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
            Adresse e-mail
          </span>
          <input
            type="email"
            value={form.email}
            maxLength={200}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
            Téléphone mobile
          </span>
          <input
            type="tel"
            value={form.phone}
            maxLength={40}
            placeholder="+213661234567"
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            En forme internationale. C&apos;est le numéro auquel les bons de
            travail sont envoyés par WhatsApp ; laissez vide si ce salarié n&apos;a
            pas de mobile.
          </span>
        </label>

        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
            Rôle
          </span>
          <select
            value={form.role}
            onChange={(e) =>
              setForm({ ...form, role: e.target.value as StaffRole })
            }
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            {STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {enumLabel(r)}
              </option>
            ))}
          </select>
        </label>

        {isTechnician && (
          <>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Disponibilité
              </span>
              <select
                value={form.status}
                onChange={(e) =>
                  setForm({ ...form, status: e.target.value as TechnicianStatus })
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                {SETTABLE_TECHNICIAN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {enumLabel(s)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                « En intervention » n&apos;est pas proposé : cet état se calcule
                à partir des affectations réelles du technicien.
              </span>
            </label>

            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Secteur habituel
              </span>
              <input
                type="text"
                value={form.defaultZone}
                maxLength={120}
                placeholder="Alger — centre"
                onChange={(e) => setForm({ ...form, defaultZone: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                Une indication pour le bureau. Elle ne filtre aucune affectation.
              </span>
            </label>

            <fieldset className="md:col-span-2">
              <legend className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
                Compétences
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {TECHNICIAN_SKILLS.map((skill) => {
                  const checked = form.specialties.includes(skill);
                  return (
                    <label
                      key={skill}
                      className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setForm({
                            ...form,
                            specialties: checked
                              ? form.specialties.filter((s) => s !== skill)
                              : [...form.specialties, skill],
                          })
                        }
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
                      />
                      {enumLabel(skill)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {isCreate ? "Créer le compte" : "Enregistrer"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          Annuler
        </button>
      </div>

      {isCreate && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Un mot de passe sera engendré et affiché une seule fois. Il ne sera
          plus jamais lisible ensuite — notez-le avant de fermer.
        </p>
      )}
    </Card>
  );
}

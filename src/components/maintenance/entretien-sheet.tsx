"use client";

import { Fragment } from "react";
import {
  ENTRETIEN_CHECKLIST,
  ENTRETIEN_FORM_CODE,
  ENTRETIEN_FORM_TITLE,
  ENTRETIEN_LEGEND,
} from "@/lib/maintenance/entretien-checklist";

/**
 * La fiche d'entretien mensuel, telle que l'entreprise l'imprime.
 *
 * ELLE REPRODUIT UN FORMULAIRE OFFICIEL
 * La grille, ses trois groupes, ses numéros (`1.1` … `3.6`), ses deux cases et
 * ses deux cadres de signature sont ceux du formulaire For: APP/DA/04/13. Une
 * feuille de contrôle se classe, s'archive et se présente à un contrôle : elle
 * doit se reconnaître au premier regard, et une version « améliorée » ne serait
 * plus le document que l'entreprise oppose.
 *
 * LA SEULE LIBERTÉ PRISE, ET ELLE EST DITE SUR LE PAPIER
 * La grille officielle n'a que deux cases. L'application distingue en plus « à
 * surveiller » et « sans objet ». Imprimer « Non conforme » sur un point qui
 * n'est qu'à surveiller serait une déclaration fausse — ce qu'une feuille de
 * contrôle ne peut pas se permettre —, et ne rien cocher sans le dire
 * ressemblerait à un oubli.
 *
 * La correspondance retenue est donc : « à surveiller » coche « Non Conf. » et
 * ouvre ses observations par « À surveiller : » ; « sans objet » ne coche rien
 * et porte « Sans objet » en observations. Une légende en pied de grille
 * l'explique, pour que le lecteur du papier n'ait pas à le deviner.
 *
 * AUCUN CHROME
 * Ce composant ne rend que le document. C'est la page qui décide de l'en-tête
 * d'application, du bouton d'impression et du fond — le papier ne doit porter
 * que la feuille.
 */

interface CheckItem {
  id: string;
  checkName: string;
  result: "PASS" | "FAIL" | "NEEDS_ATTENTION" | "NOT_APPLICABLE";
  notes: string | null;
  measuredValue: number | null;
  unit: string | null;
}

interface Signature {
  role: string;
  name: string;
  method: string;
  signedAt: string;
  imageDataUrl?: string;
}

export interface EntretienSheetReport {
  reportNumber: string;
  title: string;
  summary: string | null;
  overallResult: string;
  submittedAt: string;
  signatures: Signature[] | null;
  technician: { id: string; name: string | null };
  checkItems: CheckItem[];
  workOrder: {
    orderNumber: string;
    title: string;
    completedAt: string | null;
  };
  elevator: {
    elevatorCode: string;
    brand: string;
    model: string;
    maxPayloadKg?: number | null;
    building: { name: string; address: string; city: string };
  };
}

function formatDay(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  // Locale explicite : la feuille est classée, sa date ne doit pas dépendre du
  // poste qui l'a ouverte.
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Ce qu'une ligne coche, et ce qu'elle écrit.
 *
 * Renvoie les deux cases et le texte d'observations une fois la correspondance
 * appliquée. Écrit ici plutôt qu'à trois endroits dans le rendu : c'est la règle
 * du document, et elle doit se lire d'un bloc.
 */
function rowVerdict(item: CheckItem): {
  pass: boolean;
  fail: boolean;
  observations: string;
} {
  const notes = item.notes?.trim() ?? "";

  switch (item.result) {
    case "PASS":
      return { pass: true, fail: false, observations: notes };
    case "FAIL":
      return { pass: false, fail: true, observations: notes };
    case "NEEDS_ATTENTION":
      return {
        pass: false,
        fail: true,
        observations: notes ? `À surveiller : ${notes}` : "À surveiller.",
      };
    case "NOT_APPLICABLE":
    default:
      return {
        pass: false,
        fail: false,
        observations: notes ? `Sans objet — ${notes}` : "Sans objet.",
      };
  }
}

/** Une case à cocher du formulaire. Le ✕ est la marque d'usage en français. */
function Box({ ticked }: { ticked: boolean }) {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center border border-gray-500 text-[11px] font-bold leading-none text-gray-900"
      aria-hidden="true"
    >
      {ticked ? "✕" : ""}
    </span>
  );
}

export function EntretienSheet({ report }: { report: EntretienSheetReport }) {
  const byName = new Map(report.checkItems.map((item) => [item.checkName, item]));

  /**
   * Les lignes de la grille, dans l'ordre du formulaire.
   *
   * Le catalogue commande : une ligne du formulaire sans point correspondant
   * s'imprime vide et reste à cocher à la main — c'est un formulaire, il doit
   * rester remplissable au stylo. Et un point enregistré qui ne serait pas au
   * catalogue est ajouté à la fin plutôt que perdu : un rapport ne doit pas
   * s'imprimer en moins de lignes qu'il n'en contient.
   */
  const known = new Set<string>();
  const groups = ENTRETIEN_CHECKLIST.map((group) => ({
    title: group.title,
    rows: group.items.map((item) => {
      known.add(item.label);
      return { code: item.code, label: item.label, item: byName.get(item.label) };
    }),
  }));

  const extras = report.checkItems.filter((item) => !known.has(item.checkName));
  if (extras.length > 0) {
    groups.push({
      title: "AUTRES POINTS RELEVÉS",
      rows: extras.map((item, index) => ({
        code: String(index + 1),
        label: item.checkName,
        item,
      })),
    });
  }

  const signatures = report.signatures ?? [];
  const clientSignature = signatures.find((s) => s.role === "CLIENT");
  const technicianSignature = signatures.find((s) => s.role === "TECHNICIAN");

  return (
    <article className="mx-auto my-6 max-w-4xl bg-white p-8 shadow-sm print:my-0 print:max-w-none print:p-0 print:shadow-none">
      {/* ── En-tête du formulaire ─────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 border-b-2 border-gray-800 pb-3">
        <div>
          <p className="text-base font-bold uppercase tracking-wide text-gray-900">
            SARL RMASC
          </p>
          <h1 className="mt-1 text-lg font-bold text-gray-900">
            {ENTRETIEN_FORM_TITLE}
          </h1>
        </div>
        <div className="text-right">
          <p className="font-mono text-xs font-semibold text-gray-700">
            {ENTRETIEN_FORM_CODE}
          </p>
          <p className="mt-1 font-mono text-xs text-gray-600">
            {report.reportNumber}
          </p>
        </div>
      </header>

      {/* ── Champs d'en-tête ──────────────────────────────────── */}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Field label="Client / Résidence" value={report.elevator.building.name} />
        <Field
          label="Appareil (N° / Type)"
          value={`${report.elevator.elevatorCode} — ${report.elevator.brand} ${report.elevator.model}`}
        />
        <Field label="Date d'intervention" value={formatDay(report.submittedAt)} />
        <Field
          label="Technicien responsable"
          value={report.technician.name ?? "—"}
        />
        <Field
          label="Adresse du site"
          value={`${report.elevator.building.address}, ${report.elevator.building.city}`}
          className="col-span-2"
        />
        <Field label="Bon de travail" value={report.workOrder.orderNumber} />
      </dl>

      {/* ── Grille des points de contrôle ─────────────────────── */}
      <table className="mt-5 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-gray-100 text-left uppercase tracking-wide text-gray-700">
            <th className="w-10 border border-gray-400 px-1.5 py-1 text-center font-bold">
              N°
            </th>
            <th className="border border-gray-400 px-2 py-1 font-bold">
              Organes &amp; Points de contrôle
            </th>
            <th className="w-16 border border-gray-400 px-1.5 py-1 text-center font-bold">
              Conforme
            </th>
            <th className="w-16 border border-gray-400 px-1.5 py-1 text-center font-bold">
              Non Conf.
            </th>
            <th className="w-2/5 border border-gray-400 px-2 py-1 font-bold">
              Observations / Actions réalisées
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.title}>
              <tr>
                <td
                  colSpan={5}
                  className="border border-gray-400 bg-gray-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-800"
                >
                  {group.title}
                </td>
              </tr>
              {group.rows.map((row) => {
                const verdict = row.item
                  ? rowVerdict(row.item)
                  : { pass: false, fail: false, observations: "" };
                const measured =
                  row.item && row.item.measuredValue !== null
                    ? `Mesuré : ${row.item.measuredValue}${
                        row.item.unit ? ` ${row.item.unit}` : ""
                      }. `
                    : "";

                return (
                  <tr key={`${group.title}-${row.code}-${row.label}`} className="align-top">
                    <td className="border border-gray-400 px-1.5 py-1 text-center font-mono text-gray-700">
                      {row.code}
                    </td>
                    <td className="border border-gray-400 px-2 py-1 text-gray-900">
                      {row.label}
                    </td>
                    <td className="border border-gray-400 px-1.5 py-1 text-center">
                      <Box ticked={verdict.pass} />
                    </td>
                    <td className="border border-gray-400 px-1.5 py-1 text-center">
                      <Box ticked={verdict.fail} />
                    </td>
                    <td className="border border-gray-400 px-2 py-1 text-gray-800">
                      {measured}
                      {verdict.observations}
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>

      <p className="mt-1.5 text-[10px] italic text-gray-600">
        {ENTRETIEN_LEGEND}
      </p>

      {/* ── Remarques générales ───────────────────────────────── */}
      <section className="mt-5">
        <h2 className="border border-gray-400 border-b-0 bg-gray-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-800">
          Remarques générales / Recommandations
        </h2>
        <p className="min-h-[3.5rem] whitespace-pre-line border border-gray-400 px-2 py-1.5 text-[11px] leading-relaxed text-gray-900">
          {report.summary?.trim() || "—"}
        </p>
      </section>

      {/* ── Signatures ────────────────────────────────────────── */}
      <section className="mt-6 grid grid-cols-2 gap-6">
        <SignatureBlock
          title="Signature & Cachet Client"
          signature={clientSignature}
        />
        <SignatureBlock
          title="SARL RMASC — Le Technicien"
          signature={technicianSignature}
        />
      </section>

      <footer className="mt-6 border-t border-gray-400 pt-2 text-[10px] text-gray-600">
        {report.elevator.elevatorCode} · {report.elevator.building.name} ·
        rapport établi le {formatDay(report.submittedAt)} par{" "}
        {report.technician.name ?? "—"}.
      </footer>
    </article>
  );
}

function Field({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[10px] uppercase tracking-wide text-gray-600">
        {label}
      </dt>
      <dd className="mt-0.5 border-b border-dotted border-gray-400 pb-0.5 font-semibold text-gray-900">
        {value}
      </dd>
    </div>
  );
}

function SignatureBlock({
  title,
  signature,
}: {
  title: string;
  signature?: Signature;
}) {
  return (
    <div className="break-inside-avoid">
      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-700">
        {title}
      </p>
      <div className="mt-1 min-h-[3.5rem] border border-gray-400 px-2 py-1">
        {signature?.imageDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={signature.imageDataUrl}
            alt={`Signature de ${signature.name}`}
            className="h-14 w-full object-contain object-left"
          />
        ) : signature ? (
          <p className="font-serif text-base italic text-gray-900">
            {signature.name}
          </p>
        ) : (
          <p className="text-[10px] italic text-gray-400">
            À signer à la remise de la feuille.
          </p>
        )}
      </div>
      {signature && (
        <p className="mt-1 text-[10px] text-gray-600">
          {signature.name} · {formatDay(signature.signedAt)}
        </p>
      )}
    </div>
  );
}

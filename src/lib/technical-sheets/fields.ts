/**
 * The field catalogue for the « Fiche Technique » — the digitised form of the
 * paper document *Conception Etude & Maintenance des Ascenseurs*.
 *
 * WHY ONE CATALOGUE
 * The form has forty-odd fields spread over five sections. They are read by
 * three places that must never disagree: the client's form, the API's Zod
 * schema, and the staff read-only view. Writing the list once — here — is what
 * keeps them in step. Adding a column to the Prisma model means adding one
 * entry below, and all three follow.
 *
 * REQUIRED vs OPTIONAL, AND WHY IT IS SPLIT THIS WAY
 * A client « Sans Contrat » has no file with us: the sheet is often the first
 * thing we ever receive about the installation, and it is filled in from what
 * the caretaker can see in the machine room. Demanding the full technical
 * breakdown would mean the form is never submitted at all.
 *
 * So only four fields are required — who, where, how much, how many floors —
 * and they are exactly the four a client always knows. Everything technical is
 * optional on purpose: the client submits what they have, and the maintenance
 * team completes the rest on site. That is a deliberate trade, not an
 * oversight; `REQUIRED_FIELD_NAMES` below is the whole enforcement.
 *
 * The labels deliberately mirror the French wording of the paper form so a
 * technician holding the original can follow it line by line.
 */

export interface TechnicalSheetField {
  /** Matches the column name on the `TechnicalSheet` Prisma model. */
  name: string;
  label: string;
  placeholder?: string;
  /** Shown under the input. Use it for units and for the paper form's wording. */
  hint?: string;
}

export interface TechnicalSheetSection {
  id: string;
  title: string;
  hint?: string;
  fields: readonly TechnicalSheetField[];
}

/**
 * The four fields a client must supply.
 *
 * Declared once as a literal tuple so the API schema, the form and the
 * read-only view all read the same list. A fifth required field is added here
 * and nowhere else.
 */
export const REQUIRED_FIELD_NAMES = [
  "clientName",
  "location",
  "weightCapacity",
  "numberOfFloors",
] as const;

export type RequiredFieldName = (typeof REQUIRED_FIELD_NAMES)[number];

/** True when `name` is one of the four fields the client must fill in. */
export function isRequiredField(name: string): boolean {
  return (REQUIRED_FIELD_NAMES as readonly string[]).includes(name);
}

// ─── Sections ───────────────────────────────────────────────

export const TECHNICAL_SHEET_SECTIONS: readonly TechnicalSheetSection[] = [
  {
    id: "identification",
    title: "Identification",
    hint:
      "Les quatre premiers champs sont obligatoires. Le reste peut être complété " +
      "par notre équipe technique lors de la visite.",
    fields: [
      {
        name: "clientName",
        label: "Client",
        placeholder: "ex. : Résidence El Bahia",
        hint: "Nom du client ou de la copropriété.",
      },
      {
        name: "location",
        label: "Adresse / Localisation",
        placeholder: "ex. : 8 avenue Aouati Mostefa, Constantine",
      },
      {
        name: "weightCapacity",
        label: "Capacité / Poids",
        placeholder: "ex. : 450",
        hint: "En kilogrammes.",
      },
      {
        name: "numberOfFloors",
        label: "Nombre d'étages",
        placeholder: "ex. : 6",
      },
      {
        name: "serialNumber",
        label: "Numéro de série",
        placeholder: "ex. : 2019-4471",
      },
      {
        name: "installationDate",
        label: "Date d'installation",
        placeholder: "ex. : 2019",
      },
      {
        name: "technicianName",
        label: "Nom du technicien",
        hint: "Le technicien qui a relevé la fiche, si vous le connaissez.",
      },
    ],
  },
  {
    id: "machinerie",
    title: "Machinerie",
    hint: "Section technique — laissez vide si vous n'avez pas l'information.",
    fields: [
      {
        name: "machineType",
        label: "Type de machine",
        placeholder: "Gearless / Gearbox",
      },
      { name: "mainBreaker", label: "Disjoncteur principal" },
      { name: "plugSwitch", label: "Prise interrupteur" },
      {
        name: "speedLimiter",
        label: "Régulateur de vitesse",
        hint: "En m/s.",
      },
      {
        name: "motorType",
        label: "Type de moteur",
        hint: "Ampérage et vitesse, ex. : « 12 A / 1,6 m/s ».",
      },
      {
        name: "speedVariator",
        label: "Variateur de vitesse",
        hint: "En kW.",
      },
      { name: "arlCard", label: "Carte ARL" },
      { name: "inverter", label: "Onduleur" },
      {
        name: "brakingResistor",
        label: "Résistance de freinage",
        hint: "En ohms.",
      },
      { name: "chassis", label: "Châssis moteur" },
      { name: "tractionRope", label: "Câble de traction" },
    ],
  },
  {
    id: "toit-cabine",
    title: "Toit de cabine",
    hint: "Section technique — laissez vide si vous n'avez pas l'information.",
    fields: [
      { name: "inspectionBox", label: "Boîte d'inspection" },
      { name: "lubricator", label: "Graisseur" },
      {
        name: "overloadContactType",
        label: "Contact de surcharge",
        hint: "Indiquez le type.",
      },
      {
        name: "shoeGarnitureType",
        label: "Coulisseau et garniture",
        hint: "Indiquez le type.",
      },
      {
        name: "doorOperatorType",
        label: "Opérateur de porte",
        hint: "Indiquez le type.",
      },
      { name: "mobileCam", label: "CAM mobile" },
      { name: "impulsors", label: "Impulseurs" },
      { name: "emergencyLight", label: "Lumière de secours" },
      { name: "fan", label: "Ventilateur" },
    ],
  },
  {
    id: "cabine-palier",
    title: "Cabine et palier",
    hint: "Section technique — laissez vide si vous n'avez pas l'information.",
    fields: [
      { name: "barreaudage", label: "Barreaudage" },
      { name: "limitSwitch", label: "Fin de course" },
      {
        name: "buttonStationType",
        label: "Poste à boutons",
        hint: "Indiquez le type.",
      },
      { name: "lighting", label: "Éclairage" },
      {
        name: "cabinDoorType",
        label: "Porte cabine",
        hint: "Indiquez le type.",
      },
      { name: "display", label: "Afficheur" },
      {
        name: "photocellType",
        label: "Photocellule",
        hint: "Indiquez le type.",
      },
      { name: "soundSignal", label: "Signal sonore" },
      { name: "handrail", label: "Main courante" },
      {
        name: "landingButtonType",
        label: "Bouton palier",
        hint: "Indiquez le type.",
      },
      {
        name: "landingDoorType",
        label: "Porte palier",
        hint: "Indiquez le type.",
      },
    ],
  },
  {
    id: "gaine-cuve",
    title: "Gaine et cuve",
    hint: "Section technique — laissez vide si vous n'avez pas l'information.",
    fields: [
      { name: "shaftStop", label: "Stop cuve" },
      { name: "shaftLighting", label: "Lumière de gaine" },
      {
        name: "counterweightShoes",
        label: "Coulisseaux et garnitures contrepoids",
      },
      { name: "endLimitCam", label: "CAM fin de course" },
      { name: "pendantBrackets", label: "Pattes pendentif" },
      {
        name: "cabinGuideRails",
        label: "Guide rails cabine",
        hint: "En millimètres.",
      },
      {
        name: "counterweightGuideRails",
        label: "Guide rails contrepoids",
        hint: "En millimètres.",
      },
      { name: "shockAbsorbers", label: "Amortisseurs" },
      { name: "tensionPulley", label: "Poulie tendeuse" },
      {
        name: "parachuteType",
        label: "Parachute",
        hint: "Indiquez le type.",
      },
      {
        name: "travelHeight",
        label: "Hauteur de course",
        hint:
          "Reprend la mention « la hauteur à être » de la fiche papier. " +
          "En mètres.",
      },
    ],
  },
];

// ─── Derived lists ──────────────────────────────────────────

/** Every optional field name, in catalogue order. */
export const OPTIONAL_FIELD_NAMES: readonly string[] =
  TECHNICAL_SHEET_SECTIONS.flatMap((section) =>
    section.fields.filter((field) => !isRequiredField(field.name)).map((f) => f.name)
  );

/** Every field name the form submits, required ones first. */
export const ALL_FIELD_NAMES: readonly string[] = [
  ...REQUIRED_FIELD_NAMES,
  ...OPTIONAL_FIELD_NAMES,
];

/** The label for a field name, for the read-only view. "" when unknown. */
export function labelForField(name: string): string {
  for (const section of TECHNICAL_SHEET_SECTIONS) {
    const match = section.fields.find((field) => field.name === name);
    if (match) return match.label;
  }
  return "";
}

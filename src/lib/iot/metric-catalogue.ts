/**
 * Le catalogue des grandeurs télémetriques et de leurs seuils par défaut.
 *
 * POURQUOI CE FICHIER EXISTE SÉPARÉMENT
 * Ces valeurs vivaient dans `src/lib/iot/thresholds.ts`, qui importe le client
 * Prisma. L'écran de réglage est un composant client, et l'importer là aurait
 * tiré tout le moteur dans le bundle du navigateur — le même piège que pour les
 * compétences des techniciens. Le catalogue vit donc ici, sans dépendance, et
 * `thresholds.ts` le relit pour construire ses valeurs de repli : une seule
 * définition, lisible des deux côtés.
 *
 * LES VALEURS PAR DÉFAUT NE SONT PAS UNE SECONDE SOURCE DE VÉRITÉ
 * Elles sont le repli appliqué quand la table `ThresholdRule` est vide ou
 * injoignable, et c'est à ce titre qu'elles sont rappelées à l'écran : un
 * exploitant doit pouvoir voir ce qui s'applique réellement, et distinguer une
 * règle qu'il a réglée d'une valeur qu'il n'a jamais touchée.
 */

export interface ThresholdBounds {
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
}

export interface TelemetryMetric {
  /** La clé stockée dans `ThresholdRule.metricName` et `Alert.metricName`. */
  metricName: string;
  /** Le nom lisible, tel qu'il apparaît dans un message d'alerte persisté. */
  title: string;
  unit: string;
  description: string;
  defaults: ThresholdBounds;
}

/**
 * Les six grandeurs dont les seuils se règlent.
 *
 * `cabin_load_kg` n'y figure pas, et c'est le point le plus important de ce
 * fichier — voir `DERIVED_METRIC` ci-dessous.
 */
export const TELEMETRY_METRICS: readonly TelemetryMetric[] = [
  {
    metricName: "motor_vibration_mm_s",
    title: "Vibration élevée",
    unit: "mm/s",
    description: "Niveau de vibration du moteur",
    defaults: {
      warningMin: null,
      warningMax: 4.0,
      criticalMin: null,
      criticalMax: 7.0,
    },
  },
  {
    metricName: "motor_temperature_c",
    title: "Température moteur",
    unit: "°C",
    description: "Température des enroulements du moteur",
    defaults: {
      warningMin: null,
      warningMax: 85,
      criticalMin: null,
      criticalMax: 105,
    },
  },
  {
    metricName: "door_speed_ms",
    title: "Vitesse de porte",
    unit: "m/s",
    description: "Vitesse d'ouverture et de fermeture des portes",
    defaults: {
      warningMin: 0.3,
      warningMax: 1.5,
      criticalMin: 0.1,
      criticalMax: 2.0,
    },
  },
  {
    metricName: "leveling_offset_mm",
    title: "Écart de nivellement",
    unit: "mm",
    description: "Écart de nivellement à l'étage",
    defaults: {
      warningMin: -8,
      warningMax: 8,
      criticalMin: -15,
      criticalMax: 15,
    },
  },
  {
    metricName: "supply_voltage_v",
    title: "Tension d'alimentation",
    unit: "V",
    description: "Tension d'alimentation",
    defaults: {
      warningMin: 360,
      warningMax: 440,
      criticalMin: 340,
      criticalMax: 460,
    },
  },
  {
    metricName: "current_draw_a",
    title: "Courant moteur",
    unit: "A",
    description: "Courant absorbé par le moteur",
    defaults: {
      warningMin: null,
      warningMax: 60,
      criticalMin: null,
      criticalMax: 80,
    },
  },
];

/** Les clés dont une règle peut être écrite, dans l'ordre d'affichage. */
export const EDITABLE_METRIC_NAMES: readonly string[] = TELEMETRY_METRICS.map(
  (metric) => metric.metricName
);

/**
 * La surcharge de cabine, et pourquoi elle ne se règle pas ici.
 *
 * Une règle `ThresholdRule` écrite pour `cabin_load_kg` est **ignorée** à
 * l'ingestion : `payloadThresholds` redérive les bornes à chaque lecture depuis
 * `Elevator.maxPayloadKg`, parce qu'une surcharge n'a de sens que par rapport à
 * la capacité nominale de la machine. Un seuil absolu de 4 500 kg ne veut rien
 * dire sur un parc dont les appareils sont homologués entre 1 000 et 1 800 kg.
 *
 * C'est précisément le piège que ce catalogue doit éviter de reproduire : le
 * commentaire d'origine du module raconte que quiconque éditait cette ligne
 * « voyait le changement ne rien faire, en silence ». L'écran l'affiche donc en
 * lecture seule, avec les bornes réellement appliquées, plutôt que d'offrir un
 * champ qui n'aurait aucun effet.
 */
export const DERIVED_METRIC = {
  metricName: "cabin_load_kg",
  title: "Surcharge de la cabine",
  unit: "kg",
  description:
    "Dérivée de la charge maximale de chaque appareil : avertissement à la " +
    "capacité nominale, alerte critique à 110 %. Modifiez la charge maximale " +
    "de l'appareil pour changer ces bornes.",
} as const;

/** La politique de surcharge, écrite ici parce qu'elle est décidée en code. */
export const OVERLOAD_POLICY = { warningRatio: 1, criticalRatio: 1.1 } as const;

/**
 * Ce qui rend un jeu de bornes réfutable, ou `null` s'il tient debout.
 *
 * Trois règles, chacune pour une façon dont un seuil peut être faux :
 *
 *  1. **Aucune borne.** Une règle dont les quatre bornes sont nulles ne se
 *     déclenche jamais. L'écrire donne l'illusion d'un appareil surveillé
 *     alors qu'il ne l'est pas — la règle doit être absente, pas vide.
 *
 *  2. **L'ordre des bornes.** `evaluateThreshold` teste le critique avant
 *     l'avertissement. Un `criticalMax` inférieur au `warningMax` rend donc la
 *     borne d'avertissement *inatteignable* : toute valeur qui la dépasse
 *     dépasse déjà la borne critique. Le champ existerait sans jamais servir.
 *
 *  3. **Des bornes croisées.** Un `warningMin` supérieur au `warningMax`
 *     décrit un intervalle vide : aucune valeur ne peut être « normale ».
 *
 * La fonction vit ici, et non dans la route, pour que le formulaire applique
 * exactement la même règle que le serveur — un écran et une route qui
 * divergent sur ce point produisent un refus que l'utilisateur ne peut pas
 * comprendre.
 */
export function boundsViolation(bounds: ThresholdBounds): string | null {
  const { warningMin, warningMax, criticalMin, criticalMax } = bounds;

  if (
    warningMin === null &&
    warningMax === null &&
    criticalMin === null &&
    criticalMax === null
  ) {
    return (
      "Aucune borne n'est renseignée : une règle sans limite ne se déclenche " +
      "jamais. Renseignez au moins un maximum ou un minimum."
    );
  }

  if (warningMin !== null && warningMax !== null && warningMin > warningMax) {
    return `Le minimum d'avertissement (${warningMin}) dépasse le maximum (${warningMax}) : aucune valeur ne serait normale.`;
  }

  if (
    criticalMin !== null &&
    criticalMax !== null &&
    criticalMin > criticalMax
  ) {
    return `Le minimum critique (${criticalMin}) dépasse le maximum critique (${criticalMax}).`;
  }

  if (warningMax !== null && criticalMax !== null && criticalMax < warningMax) {
    return (
      `Le maximum critique (${criticalMax}) est inférieur au maximum ` +
      `d'avertissement (${warningMax}) : la borne d'avertissement serait ` +
      "inatteignable, toute valeur la dépassant dépassant déjà la borne critique."
    );
  }

  if (warningMin !== null && criticalMin !== null && criticalMin > warningMin) {
    return (
      `Le minimum critique (${criticalMin}) est supérieur au minimum ` +
      `d'avertissement (${warningMin}) : la borne d'avertissement serait inatteignable.`
    );
  }

  return null;
}

/** Le libellé d'une borne, « — » quand elle n'est pas posée. */
export function boundLabel(value: number | null, unit: string): string {
  if (value === null) return "—";
  return unit ? `${value} ${unit}` : String(value);
}

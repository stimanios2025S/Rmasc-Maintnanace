/**
 * Human-readable identifier generation.
 *
 * The previous implementation used `Math.random()` over 4 decimal digits
 * (10,000 values per month) against a `@unique` column, and the emergency
 * path used `Date.now().toString(36)`, which collides whenever two alerts
 * for the same elevator are handled within the same millisecond. Both
 * produced unhandled P2002 errors on the ingestion hot path.
 *
 * These use a cryptographically-random suffix drawn from a 32-character
 * alphabet (32^6 ≈ 1.07e9 combinations per month for orders), and callers
 * additionally retry once on a unique-constraint violation.
 */

// Crockford-style base32 without I/L/O/U to stay unambiguous when read aloud
// or transcribed from a printed job sheet.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SUFFIX_LENGTH = 6;

function randomSuffix(length = SUFFIX_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // 256 / 32 === 8 exactly, so the modulo introduces no bias.
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

function yearMonth(date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * `WO-202609-7KQ4ZP`
 * @param kind optional infix, e.g. "EMRG" -> `WO-EMRG-202609-7KQ4ZP`
 */
export function generateOrderNumber(kind?: string, date = new Date()): string {
  const prefix = kind ? `WO-${kind.toUpperCase()}` : "WO";
  return `${prefix}-${yearMonth(date)}-${randomSuffix()}`;
}

/** `IR-202609-4M2XTB` */
export function generateReportNumber(date = new Date()): string {
  return `IR-${yearMonth(date)}-${randomSuffix()}`;
}

/**
 * `INC-202609-9T3WVD`
 *
 * The reference a building occupant is given when they report a fault, and
 * often the only thing they can tell us over the phone. Same alphabet as the
 * others so it survives being read aloud.
 */
export function generateIncidentNumber(date = new Date()): string {
  return `INC-${yearMonth(date)}-${randomSuffix()}`;
}

/**
 * Error-code shaping shared by the lookup API, the client wizard and the demo
 * fixtures.
 *
 * This lives outside the route file because Next.js route modules may only
 * export HTTP method handlers and a small set of config values — anything
 * else fails the build. Both the route and the fixtures need the same
 * `solution` → `steps` conversion, so it needs a home of its own.
 */

export interface ErrorCodeRow {
  id: string;
  code: string;
  title: string;
  description: string;
  solution: string;
  audioUrl: string | null;
}

export interface PresentedErrorCode {
  id: string;
  code: string;
  title: string;
  description: string;
  /** Ordered resolution steps, safe to render as a numbered list. */
  steps: string[];
  audioUrl: string | null;
}

/**
 * Splits the stored newline-separated solution into ordered steps.
 *
 * Blank lines are dropped rather than rendered as empty list items — the seed
 * copy is written with paragraph breaks between steps, and a stray double
 * newline should not produce a blank step for the accessibility mode to read
 * aloud as silence.
 */
export function splitSolution(solution: string): string[] {
  return solution
    .split(/\r?\n/)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

export function presentErrorCode(row: ErrorCodeRow): PresentedErrorCode {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    steps: splitSolution(row.solution),
    audioUrl: row.audioUrl,
  };
}

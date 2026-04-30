// ============================================================
// FOSE Term-Code Encoding (Phase 10 Stage 2)
// ============================================================
// NYU's FOSE class-search API encodes terms as a 4-digit code:
//   1 + {last two digits of year} + {4=spring, 6=summer, 8=fall}
// e.g. Fall 2026 = 1268, Spring 2027 = 1274.
//
// Phase 9.5 documented this in a comment inside searchAvailability.ts.
// Phase 10 promotes it to a tested, exported function so the rule has
// one source of truth + unit-test coverage. searchAvailability.ts now
// delegates to encodeFoseTerm() rather than carrying its own logic.
//
// The original generateTermCode() in api/nyuClassSearch.ts remains as
// a thin re-export so existing callers don't break.
// ============================================================

export type FoseTerm = "spring" | "summer" | "fall";

export interface DecodedFoseTerm {
    year: number;
    term: FoseTerm;
}

const TERM_DIGIT: Record<FoseTerm, number> = {
    spring: 4,
    summer: 6,
    fall: 8,
};

const DIGIT_TERM: Record<number, FoseTerm> = {
    4: "spring",
    6: "summer",
    8: "fall",
};

/**
 * Encode (year, term) as a 4-digit FOSE term code.
 *
 * @example encodeFoseTerm(2026, "fall") === "1268"
 * @example encodeFoseTerm(2027, "spring") === "1274"
 */
export function encodeFoseTerm(year: number, term: FoseTerm): string {
    if (!Number.isInteger(year) || year < 2000 || year > 2099) {
        throw new RangeError(`encodeFoseTerm: year must be 2000-2099 (got ${year})`);
    }
    const tail = TERM_DIGIT[term];
    if (tail === undefined) {
        throw new RangeError(`encodeFoseTerm: term must be spring/summer/fall (got ${term})`);
    }
    const yy = String(year % 100).padStart(2, "0");
    return `1${yy}${tail}`;
}

/**
 * Decode a 4-digit FOSE term code back to (year, term).
 * Returns null for malformed input.
 */
export function decodeFoseTerm(code: string): DecodedFoseTerm | null {
    if (!/^1\d{2}[468]$/.test(code)) return null;
    const yy = parseInt(code.slice(1, 3), 10);
    const digit = parseInt(code.slice(3), 10);
    const term = DIGIT_TERM[digit];
    if (!term) return null;
    // 2000-2099 window is unambiguous: prefix "1" + yy + digit.
    return { year: 2000 + yy, term };
}

/**
 * Render a FOSE code as a human-readable label, e.g. "Fall 2026".
 */
export function foseTermLabel(code: string): string | null {
    const d = decodeFoseTerm(code);
    if (!d) return null;
    return `${d.term[0]!.toUpperCase()}${d.term.slice(1)} ${d.year}`;
}

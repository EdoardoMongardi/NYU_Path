// ============================================================
// NYU Class Search API Client (Phase 1)
// ============================================================
// Uses the public Leepfrog/FOSE API at bulletins.nyu.edu
// Endpoint: POST /class-search/api/?page=fose&route=search|details
// ============================================================

/** Raw search result from the FOSE API */
export interface FoseSearchResult {
    /** Internal key for details lookup, e.g. "4930" */
    key: string;
    /** Course code, e.g. "CSCI-UA 101" */
    code: string;
    /** Course title */
    title: string;
    /** Course registration number */
    crn: string;
    /** Source database (term code), e.g. "1254" */
    srcdb: string;
    /** Enrollment status: "O" = open, "W" = waitlist, "C" = closed */
    stat: string;
    /** Meeting times as formatted HTML */
    hours?: string;
    /** Instructor name(s) */
    instr?: string;
    /** Credits */
    credits?: string;
}

/** Search response from the FOSE API */
export interface FoseSearchResponse {
    results: FoseSearchResult[];
    totalCount: number;
    srcdb: string;
}

/** Detail response from the FOSE API */
export interface FoseDetailResponse {
    /** HTML formatted description */
    description?: string;
    /** HTML formatted class notes (prerequisites/registration info) */
    clssnotes?: string;
    /** Legacy alias — some responses use classnotes */
    classnotes?: string;
    /** Credit hours (HTML formatted) */
    hours_html?: string;
    /** Credit hours */
    hours?: string;
    /** Registration restrictions / prerequisites */
    registration_restrictions?: string;
    /** Full raw response */
    [key: string]: unknown;
}

// ---- Term Code Mapping ----
// NYU term codes follow a pattern: YYTC where
// YY = last 2 digits of year, T = term type (2=Spring, 6=Summer, 8=Fall)
// preceded by "1" → e.g. Spring 2025 = 1252, but the actual code used is "1254"
// We'll use a known mapping and a helper to generate codes.

export interface TermOption {
    code: string;
    label: string;
    year: number;
    term: "spring" | "summer" | "fall";
}

/**
 * Generate a term code for the FOSE API.
 * Based on observed pattern: Spring 2025 = "1254"
 * Pattern appears to be: 1 + (year - 1900) + semester_digit
 * where semester_digit: 2=Spring, 6=Summer, 8=Fall
 * e.g. 2025: 1 + 125 + 4(spring?)
 *
 * NOTE: Term codes may not follow a strict pattern.
 * This function provides best-effort mapping.
 * Verified codes should be cached.
 */
export function generateTermCode(year: number, term: "spring" | "summer" | "fall"): string {
    // Observed: Spring 2025 = "1254"
    // Possible pattern: "1" + last 2 digits of year + suffix
    // 2025 Spring → "1254", Fall → "1258", Summer → "1256"
    // 2024 Spring → "1244", Fall → "1248", Summer → "1246"
    const lastTwo = year % 100;
    const suffix = term === "spring" ? 4 : term === "summer" ? 6 : 8;
    return `1${lastTwo}${suffix}`;
}

/**
 * List available terms that are likely active on the FOSE API.
 * We generate codes for the current and adjacent academic years.
 */
export function getRecentTermOptions(): TermOption[] {
    const now = new Date();
    const currentYear = now.getFullYear();
    const terms: TermOption[] = [];

    for (let year = currentYear - 1; year <= currentYear + 1; year++) {
        for (const term of ["spring", "summer", "fall"] as const) {
            terms.push({
                code: generateTermCode(year, term),
                label: `${term.charAt(0).toUpperCase() + term.slice(1)} ${year}`,
                year,
                term,
            });
        }
    }

    return terms;
}

const API_BASE = "https://bulletins.nyu.edu/class-search/api/";

/**
 * Search for courses in a specific term.
 *
 * @param termCode - FOSE term code, e.g. "1254" for Spring 2025
 * @param keyword - Search keyword, e.g. "CSCI-UA" for all CS courses
 * @returns Array of search results
 */
export async function searchCourses(
    termCode: string,
    keyword: string
): Promise<FoseSearchResult[]> {
    const url = `${API_BASE}?page=fose&route=search`;
    const payload = {
        other: { srcdb: termCode },
        criteria: [{ field: "keyword", value: keyword }],
    };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`FOSE search failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as FoseSearchResponse;
    return data.results ?? [];
}

/**
 * Get detailed information about a specific course section.
 *
 * @param termCode - FOSE term code
 * @param crn - Course CRN from search results (e.g. "10403")
 * @returns Detailed course info including description and prerequisites
 */
export async function getCourseDetails(
    termCode: string,
    crn: string
): Promise<FoseDetailResponse> {
    const url = `${API_BASE}?page=fose&route=details`;
    // The FOSE API details endpoint requires the key in "crn:CRN" format
    const payload = { srcdb: termCode, key: `crn:${crn}` };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`FOSE details failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as FoseDetailResponse;
}

/**
 * Fetch all CS and Math courses for a given term.
 * This is the main convenience function for the planner.
 *
 * @param termCode - FOSE term code
 * @returns Object with CSCI and MATH courses
 */
export async function fetchTermCourses(termCode: string): Promise<{
    csci: FoseSearchResult[];
    math: FoseSearchResult[];
}> {
    const [csci, math] = await Promise.all([
        searchCourses(termCode, "CSCI-UA"),
        searchCourses(termCode, "MATH-UA"),
    ]);

    return { csci, math };
}

/**
 * Extract available course IDs from search results.
 * Only includes courses with status "O" (open) or "W" (waitlist).
 */
export function extractAvailableCourseIds(results: FoseSearchResult[]): string[] {
    const available = results.filter(r => r.stat === "O" || r.stat === "W");
    // Deduplicate by course code (multiple sections of same course)
    const seen = new Set<string>();
    return available
        .map(r => r.code)
        .filter(code => {
            if (seen.has(code)) return false;
            seen.add(code);
            return true;
        });
}

/**
 * Get all unique course codes offered in a term (regardless of enrollment status).
 */
export function extractAllCourseIds(results: FoseSearchResult[]): string[] {
    const seen = new Set<string>();
    return results
        .map(r => r.code)
        .filter(code => {
            if (seen.has(code)) return false;
            seen.add(code);
            return true;
        });
}

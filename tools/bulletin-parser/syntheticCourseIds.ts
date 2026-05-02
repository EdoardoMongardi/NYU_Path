// ============================================================
// Phase 12.8 Task 2 — synthetic AP/IB exam courseId helper
// ============================================================
//
// PURPOSE
// -------
// The bulletin's prereq strings reference AP/IB exam-with-score
// equivalencies inline alongside normal NYU course IDs. We mint
// per-exam-per-score synthetic IDs (locked Decision Y) so the
// solver can treat them uniformly inside `prereqGroups[].courses`.
//
//   AP-<SUBJECT-CODE>-<SCORE>           e.g. AP-CS-A-3, AP-CALC-BC-5
//   IB-<SUBJECT-CODE>-<LEVEL>-<SCORE>   e.g. IB-MATH-HL-5, IB-CS-SL-5
//
// HARD INVARIANT
// --------------
// There is NO `PLACEMENT_EXAM` fallback. If the exam name is not in
// the dictionary, the helper returns `null` and the caller logs +
// omits. Inventing a generic token destroys the per-exam mapping the
// solver depends on.
//
// REAL BULLETIN PHRASINGS (verified 2026-05-02 against
// data/bulletin-raw/courses/{csci,math,econ,biol,chem,arth,fren,
// phys,anth,psych}_ua/_index.md):
//
//   PREAMBLES
//     "Advanced Placement Examination <Subject>"     <-- canonical
//     "AP Exam <Subject>"                            <-- econ_ua, phys_ua
//     "AP <Subject>"                                 <-- ASCII shorthand
//
//   OPERATORS
//     ">= N"           <-- canonical (with or without space)
//     "≥ N"            <-- Unicode variant (rare, defensive)
//     "Score >= N"     <-- IB HL Psychology Score >= 6 (psych_ua)
//     "SCORE GREATER OR EQUAL TO N"  <-- bulletin's all-caps PSYCH-UA
//                                       variant; the bare-AP form has
//                                       no subject so we return null.
//
//   AP SUBJECT QUIRKS
//     "Economics - Microeconomics" / "Macroeconomics" (econ_ua, hyphen)
//     "Calc AB" / "Calc BC" / "Calc ABSub" (phys_ua shorthand)
//     "Calculus AB Subscore" (math_ua, AP Calc-AB sub-score)
//     "Computer Science AB" (legacy exam, csci_ua)
//     "Spanish/French Literature" (anth_ua, fren_ua — ≠ AP "Spanish/
//      French Language and Culture", which is a DIFFERENT exam)
//
//   IB FORMS
//     "IB HL <Subject> Score >= N"
//     "IB Higher Level <Subject> >= N"
//     "IB Standard Level <Subject> >= N"
//     "IB SL <Subject> >= N"
//
// The dicts below are keyed on lowercased canonical names; aliases
// are normalized to canonical before lookup.

export interface ExamScore {
    /** Canonical exam name, e.g. "AP Computer Science A". */
    exam: string;
    /** 1-7 for AP (3-5 typical pass), 1-7 for IB. */
    score: number;
}

// ------------------------------------------------------------
// Subject-code dictionaries
// ------------------------------------------------------------
//
// Keys are LOWERCASED canonical exam names; lookup callers MUST
// `.toLowerCase().trim()` the input first. The canonical name is
// the form `synthesizeCourseId` accepts as its `exam` field; the
// parsers normalize bulletin variants to it via APSubjectAliases /
// IBSubjectAliases below.

const AP_SUBJECT_CODES: Record<string, string> = {
    // Computer Science
    "ap computer science a": "CS-A",
    "ap computer science ab": "CS-AB",
    "ap computer science principles": "CS-P",
    // Mathematics
    "ap calculus ab": "CALC-AB",
    "ap calculus bc": "CALC-BC",
    "ap calculus ab subscore": "CALC-AB-SUB",
    "ap statistics": "STATS",
    // Sciences
    "ap biology": "BIO",
    "ap chemistry": "CHEM",
    "ap physics 1": "PHYS-1",
    "ap physics 2": "PHYS-2",
    "ap physics c mechanics": "PHYS-C-MECH",
    "ap physics c electricity and magnetism": "PHYS-C-EM",
    // Social sciences
    "ap microeconomics": "ECON-MICRO",
    "ap macroeconomics": "ECON-MACRO",
    "ap us history": "USH",
    "ap world history": "WH",
    "ap european history": "EH",
    "ap psychology": "PSYCH",
    // Humanities
    "ap english language and composition": "ENG-LANG",
    "ap english literature and composition": "ENG-LIT",
    "ap art history": "ART-HIST", // present in arth_ua bulletin
    // Languages
    "ap french language and culture": "FRENCH",
    "ap french literature": "FRENCH-LIT", // present in fren_ua bulletin
    "ap spanish language and culture": "SPANISH",
    "ap spanish literature": "SPANISH-LIT", // present in anth_ua bulletin
    "ap chinese language and culture": "CHINESE",
    "ap latin": "LATIN",
};

const IB_SUBJECT_CODES: Record<string, { code: string; level: "HL" | "SL" }> = {
    "ib higher level mathematics": { code: "MATH", level: "HL" },
    "ib higher level computer science": { code: "CS", level: "HL" },
    "ib higher level chemistry": { code: "CHEM", level: "HL" },
    "ib higher level biology": { code: "BIO", level: "HL" },
    "ib higher level physics": { code: "PHYS", level: "HL" },
    "ib higher level economics": { code: "ECON", level: "HL" },
    "ib higher level history": { code: "HIST", level: "HL" },
    "ib higher level psychology": { code: "PSYCH", level: "HL" },
    "ib standard level mathematics": { code: "MATH", level: "SL" },
    "ib standard level computer science": { code: "CS", level: "SL" },
    "ib standard level chemistry": { code: "CHEM", level: "SL" },
    "ib standard level biology": { code: "BIO", level: "SL" },
    "ib standard level physics": { code: "PHYS", level: "SL" },
};

// ------------------------------------------------------------
// Bulletin-variant → canonical-name aliases
// ------------------------------------------------------------
//
// Keys are LOWERCASED bulletin subject text (the part between the
// preamble and the operator), values are the LOWERCASED canonical
// AP_SUBJECT_CODES / IB_SUBJECT_CODES key. Used by parseAPClause /
// parseIBClause to normalize the captured subject before dict
// lookup so that, e.g., the bulletin's "Calc AB" maps to the
// canonical "AP Calculus AB".

const AP_SUBJECT_ALIASES: Record<string, string> = {
    // Hyphen Economics forms (econ_ua)
    "economics - microeconomics": "microeconomics",
    "economics - macroeconomics": "macroeconomics",
    // "Calc" shorthand (phys_ua)
    "calc ab": "calculus ab",
    "calc bc": "calculus bc",
    "calc absub": "calculus ab subscore",
    "calculus ab subscore": "calculus ab subscore",
};

const IB_SUBJECT_ALIASES: Record<string, "HL" | "SL"> = {
    "hl": "HL",
    "higher level": "HL",
    "sl": "SL",
    "standard level": "SL",
};

// ------------------------------------------------------------
// synthesizeCourseId
// ------------------------------------------------------------

/**
 * Mint a synthetic courseId from an exam + score. Returns null when
 * the exam name isn't in the AP/IB dictionary (caller should log + skip).
 *
 * Naming convention:
 *   AP-<SUBJECT-CODE>-<SCORE>     — e.g. AP-CS-A-3, AP-CALC-BC-5
 *   IB-<SUBJECT-CODE>-<LEVEL>-<SCORE>  — e.g. IB-MATH-HL-5
 */
export function synthesizeCourseId(exam: ExamScore): string | null {
    const key = exam.exam.toLowerCase().trim();
    if (!key) return null;
    const score = Math.trunc(exam.score);

    if (key.startsWith("ap ")) {
        const code = AP_SUBJECT_CODES[key];
        if (!code) return null;
        return `AP-${code}-${score}`;
    }

    if (key.startsWith("ib ")) {
        const entry = IB_SUBJECT_CODES[key];
        if (!entry) return null;
        return `IB-${entry.code}-${entry.level}-${score}`;
    }

    return null;
}

// ------------------------------------------------------------
// parseAPClause
// ------------------------------------------------------------
//
// Regex anatomy (non-anchored — extracts the AP portion from any
// surrounding text):
//
//   (Advanced\s+Placement(?:\s+Examination)?|AP\s+Exam|AP)
//     — preambles seen in the bulletin: "Advanced Placement",
//       "Advanced Placement Examination", "AP Exam", "AP".
//
//   \s+([A-Za-z][A-Za-z0-9\s\-]*?)
//     — subject; allows letters, digits, spaces, hyphens.
//       Non-greedy so the operator anchor terminates capture.
//       Starts with a letter (skips bare "AP SCORE..." which has
//       no subject before the operator).
//
//   \s*(?:>=|≥|>=)\s*(\d)
//     — operator + 1-digit score (AP scores are 1-5).
//
// We deliberately do NOT match "SCORE GREATER OR EQUAL TO N" for
// the bare-AP form "AP SCORE GREATER OR EQUAL TO N" (no subject)
// because the bulletin uses it without a subject — caller must skip.

const AP_CLAUSE_RE =
    /(?:Advanced\s+Placement(?:\s+Examination)?|AP\s+Exam|AP)\s+([A-Za-z][A-Za-z0-9\s\-]*?)\s*(?:>=|≥)\s*(\d)/i;

/** Parse one bulletin AP clause to {exam, score}; null if no clause. */
export function parseAPClause(text: string): ExamScore | null {
    if (!text) return null;
    const match = AP_CLAUSE_RE.exec(text);
    if (!match) return null;

    const subjectRaw = match[1].trim();
    const scoreRaw = match[2];

    // Strip any accidental trailing connectors (defensive for noisy capture).
    const subject = subjectRaw.replace(/\s+/g, " ").toLowerCase();

    // Reject the bare-AP "AP SCORE..." form — score-keyword captured as subject.
    if (/^score(\s|$)/i.test(subject)) return null;

    // Normalize bulletin variants to the canonical AP_SUBJECT_CODES key form.
    const aliased = AP_SUBJECT_ALIASES[subject] ?? subject;
    const canonicalKey = `ap ${aliased}`;

    if (!(canonicalKey in AP_SUBJECT_CODES)) return null;

    return {
        exam: toCanonicalAPDisplayName(canonicalKey),
        score: parseInt(scoreRaw, 10),
    };
}

// ------------------------------------------------------------
// parseIBClause
// ------------------------------------------------------------
//
// Regex anatomy:
//
//   IB\s+(HL|SL|Higher\s+Level|Standard\s+Level)
//     — required level marker (no bare "IB SCORE..." which has none).
//
//   \s+([A-Za-z][A-Za-z0-9\s]*?)
//     — subject; letters/digits/spaces.
//
//   (?:\s+Score)?       — optional "Score" word ("IB HL Psychology Score >= 6").
//
//   \s*(?:>=|≥)\s*(\d)
//     — operator + 1-digit score (IB scores are 1-7).

const IB_CLAUSE_RE =
    /IB\s+(HL|SL|Higher\s+Level|Standard\s+Level)\s+([A-Za-z][A-Za-z0-9\s]*?)(?:\s+Score)?\s*(?:>=|≥)\s*(\d)/i;

/** Parse one bulletin IB clause to {exam, score}; null if no clause. */
export function parseIBClause(text: string): ExamScore | null {
    if (!text) return null;
    const match = IB_CLAUSE_RE.exec(text);
    if (!match) return null;

    const levelRaw = match[1].toLowerCase().trim();
    const subjectRaw = match[2].trim();
    const scoreRaw = match[3];

    const level = IB_SUBJECT_ALIASES[levelRaw];
    if (!level) return null;

    const subject = subjectRaw.replace(/\s+/g, " ").toLowerCase();
    const levelWord = level === "HL" ? "higher level" : "standard level";
    const canonicalKey = `ib ${levelWord} ${subject}`;

    if (!(canonicalKey in IB_SUBJECT_CODES)) return null;

    return {
        exam: toCanonicalIBDisplayName(canonicalKey),
        score: parseInt(scoreRaw, 10),
    };
}

// ------------------------------------------------------------
// Canonical-name display helpers
// ------------------------------------------------------------
//
// Produce the same casing the public API expects so that the
// returned `exam` string round-trips through `synthesizeCourseId`
// without further normalization at the call site.

function toCanonicalAPDisplayName(lowerKey: string): string {
    // lowerKey is "ap <subject>"; produce "AP <Subject Title-Cased>"
    // with special-case caps for known acronyms.
    const subject = lowerKey.slice(3); // strip leading "ap "
    return `AP ${titleCaseSubject(subject)}`;
}

function toCanonicalIBDisplayName(lowerKey: string): string {
    // lowerKey is "ib higher level <subject>" or "ib standard level <subject>".
    const rest = lowerKey.slice(3); // strip leading "ib "
    const isHL = rest.startsWith("higher level ");
    const levelWord = isHL ? "Higher Level" : "Standard Level";
    const subject = rest.slice(isHL ? "higher level ".length : "standard level ".length);
    return `IB ${levelWord} ${titleCaseSubject(subject)}`;
}

function titleCaseSubject(s: string): string {
    return s
        .split(" ")
        .map((word) => {
            if (word.length === 0) return word;
            // Preserve known acronyms / multi-letter abbreviations
            // present in canonical AP exam names.
            const upper = word.toUpperCase();
            if (upper === "AB" || upper === "BC" || upper === "US") return upper;
            if (upper === "A" || upper === "P") return upper; // "A", "Principles" P stays normal — see below
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(" ");
}

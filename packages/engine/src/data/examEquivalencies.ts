// ============================================================
// Exam Equivalencies — Deterministic AP/IB/A-Level Lookup
// ============================================================
// Source: Original rules/General rules for transfer credits.md
// Every entry below is copied verbatim from that file.
// NEVER add entries not found in the source file.
// ============================================================

export interface ExamResult {
    /** Credits awarded */
    credits: number;
    /** NYU course equivalent(s), if any */
    nyuEquivalent?: string[];
    /** Core requirement(s) satisfied, if any */
    coreSatisfaction?: string[];
    /** Important notes/restrictions from the source file */
    notes?: string[];
}

// ---- AP Equivalencies ----
// Source: "AP Equivalencies" table + footnotes (lines 163-252)

interface APEntry {
    scores: number[];
    credits: number;
    nyuEquivalent?: string[];
    coreSatisfaction?: string[];
    notes?: string[];
}

const AP_TABLE: Record<string, APEntry[]> = {
    "African American Studies": [
        { scores: [4, 5], credits: 4, notes: ["No course equivalent", "In some cases may be applicable to certain majors/minors in Dept of Social and Cultural Analysis"] },
    ],
    "Art History": [
        { scores: [4], credits: 4, notes: ["No course equivalent", "Does not count toward Art History major or minor"] },
        { scores: [5], credits: 4, nyuEquivalent: ["ARTH-UA 10"], notes: ["Art History majors exempt from ARTH-UA 10; counts as one course for major", "Never counts toward the minor"] },
    ],
    "Biology": [
        { scores: [4, 5], credits: 8, nyuEquivalent: ["BIOL-UA 11", "BIOL-UA 12"], coreSatisfaction: ["Physical Science", "Life Science"], notes: ["Prehealth students cannot place out of BIOL-UA 11/12", "Non-prehealth can apply toward Bio majors/minors"] },
    ],
    "Calculus AB": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["MATH-UA 121"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["Econ majors cannot use for MATH-UA 131/132/133"] },
    ],
    "Calculus BC": [
        { scores: [4], credits: 4, nyuEquivalent: ["MATH-UA 121"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["Econ majors cannot use for MATH-UA 131/132/133", "If BC < 4 but AB subscore 4/5, still awarded 4 credits for MATH-UA 121"] },
        { scores: [5], credits: 8, nyuEquivalent: ["MATH-UA 121", "MATH-UA 122"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["Econ majors cannot use for MATH-UA 131/132/133"] },
    ],
    "Chemistry": [
        { scores: [4, 5], credits: 8, nyuEquivalent: ["CHEM-UA 125", "CHEM-UA 126"], coreSatisfaction: ["Physical Science", "Life Science"], notes: ["Does not count toward Bio/Chem majors or minors", "Cannot serve as co/prerequisite to Bio/Chem courses", "Prehealth cannot place out of CHEM-UA 125/126", "Not equivalent to CHEM-UA 129 Accelerated General Chemistry"] },
    ],
    "Chinese Language and Culture": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["EAST-UA 204"], coreSatisfaction: ["Foreign Language"], notes: ["Cannot be used for placement in Chinese at NYU; must take CAS placement exam", "Cannot apply to East Asian Studies major or minor"] },
    ],
    "Computer Science A": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["CSCI-UA 101"], notes: ["Does not count toward minor in Web Programming only (not CS major per CS dept policy)", "Students must consult CS department about counting toward major"] },
    ],
    "Computer Science Principles": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["CSCI-UA 2"], notes: ["Can count toward minor in Web Programming and Applications", "Does not count toward any major in Computer Science"] },
    ],
    "English Literature": [
        { scores: [4, 5], credits: 4, notes: ["No course equivalent"] },
    ],
    "English Language": [
        // No credit awarded
    ],
    "Environmental Science": [
        { scores: [4, 5], credits: 4, coreSatisfaction: ["Physical Science"], notes: ["No course equivalent", "Does not count toward Environmental Studies major or minor"] },
    ],
    "European History": [
        { scores: [4, 5], credits: 4, notes: ["No course equivalent", "Can count as elective toward History major (max 4 credits)", "Cannot count toward History minor"] },
    ],
    "French Language and Culture": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["FREN-UA 30"], coreSatisfaction: ["Foreign Language"] },
    ],
    "German Language and Culture": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["GERM-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Does not reduce courses required for German major"] },
    ],
    "Human Geography": [
        // No credit awarded
    ],
    "Italian Language and Culture": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["ITAL-UA 12"], coreSatisfaction: ["Foreign Language"] },
    ],
    "Japanese Language and Culture": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["EAST-UA 250"], coreSatisfaction: ["Foreign Language"], notes: ["Cannot be used for placement; must take CAS placement exam", "Cannot apply to East Asian Studies major or minor"] },
    ],
    "Latin": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["CLASS-UA 6"], coreSatisfaction: ["Foreign Language"], notes: ["Must consult Classics dept for placement", "Will not reduce courses for Classics major or minor"] },
    ],
    "Macroeconomics": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["ECON-UA 1"], notes: ["Satisfies intro requirement for Econ major/minor, IR major, Public Policy major, Business Studies minor"] },
    ],
    "Microeconomics": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["ECON-UA 2"], notes: ["Satisfies intro requirement for Econ major/minor, IR major, Business Studies minor"] },
    ],
    "Music Theory": [
        { scores: [4, 5], credits: 4, notes: ["No course equivalent", "Does not count toward Music major or minor"] },
    ],
    "Physics 1": [
        { scores: [4, 5], credits: 4, coreSatisfaction: ["Physical Science"], notes: ["No course equivalent", "Does not count toward Physics major or minor", "Cannot combine with Physics C for duplicate material"] },
    ],
    "Physics 2": [
        { scores: [4, 5], credits: 4, coreSatisfaction: ["Physical Science"], notes: ["No course equivalent", "Does not count toward Physics major or minor", "Cannot combine with Physics C E&M for duplicate material"] },
    ],
    "Physics C—Mechanics": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["PHYS-UA 11"], coreSatisfaction: ["Physical Science"], notes: ["Prehealth cannot place out of PHYS-UA 11", "Potential Physics majors: consult dept about PHYS-UA 91 placement"] },
    ],
    "Physics C—E&M": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["PHYS-UA 12"], coreSatisfaction: ["Physical Science"], notes: ["Prehealth cannot place out of PHYS-UA 12", "Potential Physics majors: consult dept about PHYS-UA 93 placement"] },
    ],
    "Politics (U.S. Gov't and Politics)": [
        { scores: [4, 5], credits: 4, notes: ["No specific course equivalent; counts as generic POL-UA credit", "Max 8 AP credits (2 courses) toward Politics major, 4 credits (1 course) toward minor"] },
    ],
    "Politics (Comp. Gov't and Politics)": [
        { scores: [4, 5], credits: 4, notes: ["No specific course equivalent; counts as generic POL-UA credit", "Max 8 AP credits (2 courses) toward Politics major, 4 credits (1 course) toward minor"] },
    ],
    "Precalculus": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["MATH-UA 9"], notes: ["Prerequisite satisfaction only", "NEVER counts toward any major/minor or Core requirement"] },
    ],
    "Psychology": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["PSYCH-UA 1"] },
    ],
    "Spanish Language and Culture": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["SPAN-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Non-natives must take CAS placement exam", "Scores > 18 months old cannot be used for placement"] },
    ],
    "Spanish Literature and Culture": [
        { scores: [4], credits: 4, nyuEquivalent: ["SPAN-UA 50"], coreSatisfaction: ["Foreign Language"], notes: ["Non-natives take in-class exam on first day; may result in lower level and loss of AP credit"] },
        { scores: [5], credits: 4, nyuEquivalent: ["SPAN-UA 50"], coreSatisfaction: ["Foreign Language"], notes: ["Must take special advanced placement evaluation through Spanish dept"] },
    ],
    "Statistics": [
        { scores: [4, 5], credits: 4, nyuEquivalent: ["PSYCH-UA 10"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["Satisfies first semester of Psychology major stats requirement", "Does not count toward Econ, IR, Sociology majors or Business Studies minor"] },
    ],
    "Studio Art": [
        // No credit awarded
    ],
    "U.S. History": [
        { scores: [4, 5], credits: 4, notes: ["No course equivalent", "Can count as elective toward History major (max 4 credits)", "Cannot count toward History minor"] },
    ],
    "World History": [
        { scores: [4, 5], credits: 4, notes: ["No course equivalent", "Can count as elective toward History major (max 4 credits)", "Cannot count toward History minor"] },
    ],
};

// ---- IB HL Equivalencies ----
// Source: "International Baccalaureate (IB) Equivalencies" table + footnotes (lines 255-353)
// All IB entries require HL only, scores 6 or 7, awarding 8 credits each.

interface IBEntry {
    scores: number[];
    credits: number;
    nyuEquivalent?: string[];
    coreSatisfaction?: string[];
    notes?: string[];
}

const IB_TABLE: Record<string, IBEntry[]> = {
    "Analysis and Approaches (Mathematics)": [
        { scores: [6], credits: 8, nyuEquivalent: ["MATH-UA 121"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["4 of 8 credits equivalent to MATH-UA 121", "Econ majors cannot use for MATH-UA 131/132/133"] },
        { scores: [7], credits: 8, nyuEquivalent: ["MATH-UA 121", "MATH-UA 122"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["Students entering Calc III should review polar coordinates and parametric equations", "Econ majors cannot use for MATH-UA 131/132/133"] },
    ],
    "Applications and Interpretation (Mathematics)": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["MATH-UA 121"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["4 of 8 credits equivalent to MATH-UA 121", "Econ majors cannot use for MATH-UA 131/132/133"] },
    ],
    "Arabic A or B": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register for language at NYU"] },
    ],
    "Biology": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["BIOL-UA 11", "BIOL-UA 12"], coreSatisfaction: ["Physical Science", "Life Science"], notes: ["Prehealth cannot place out of BIOL-UA 11/12", "Non-prehealth should consult Bio dept about major/minor credit"] },
    ],
    "Chemistry": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["CHEM-UA 125", "CHEM-UA 126"], coreSatisfaction: ["Physical Science", "Life Science"], notes: ["Does not count toward Bio/Chem majors or minors", "Prehealth cannot place out of CHEM-UA 125/126", "Not equivalent to CHEM-UA 129"] },
    ],
    "Chinese A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Chinese B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["EAST-UA 203", "EAST-UA 204"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Classical Greek": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["CLASS-UA 9", "CLASS-UA 10"], coreSatisfaction: ["Foreign Language"], notes: ["Consult Classics dept for placement", "Will not reduce courses for Classics major/minor"] },
    ],
    "Computer Science": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["CSCI-UA 101", "CSCI-UA 102"], notes: ["Must consult CS department about counting toward major/minor"] },
    ],
    "Economics": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["ECON-UA 1", "ECON-UA 2"], notes: ["Satisfies intro requirements for Econ major/minor, IR major, Business Studies minor"] },
    ],
    "English Literature A": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent", "No credit for English B exam"] },
    ],
    "English Language and Literature A": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent", "No credit for English B exam"] },
    ],
    "Environmental Systems and Societies": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent", "First assessment 2026"] },
    ],
    "French A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "A language: must take CAS placement exam to register"] },
    ],
    "French B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["FREN-UA 11", "FREN-UA 12"], coreSatisfaction: ["Foreign Language"] },
    ],
    "German A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent"] },
    ],
    "German B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["GERM-UA 3", "GERM-UA 4"], coreSatisfaction: ["Foreign Language"] },
    ],
    "Global Politics": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent", "Max 8 credits toward Politics major, 4 toward minor; counts as generic POL-UA credit"] },
    ],
    "Hebrew A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent"] },
    ],
    "Hebrew B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["HBRJD-UA 3", "HBRJD-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam to register"] },
    ],
    "Hindi A or B": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "History of Africa and the Middle East": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent", "Max 4 of 8 credits toward History major; not for minor"] },
    ],
    "History of the Americas": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent"] },
    ],
    "History of Asia and Oceania": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent"] },
    ],
    "History of Europe": [
        { scores: [6, 7], credits: 8, notes: ["No course equivalent"] },
    ],
    "Italian A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent"] },
    ],
    "Italian B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["ITAL-UA 11", "ITAL-UA 12"], coreSatisfaction: ["Foreign Language"] },
    ],
    "Japanese A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Japanese B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["EAST-UA 249", "EAST-UA 250"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Korean A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Korean B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["EAST-UA 256", "EAST-UA 257"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Latin": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["CLASS-UA 5", "CLASS-UA 6"], coreSatisfaction: ["Foreign Language"], notes: ["Consult Classics dept for placement", "Will not reduce courses for Classics major/minor"] },
    ],
    "Persian A or B": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "Philosophy": [
        { scores: [6], credits: 8, notes: ["No course equivalent at score 6; does not count toward Philosophy major/minor"] },
        { scores: [7], credits: 8, nyuEquivalent: ["PHIL-UA 1"], notes: ["4 of 8 credits count toward Philosophy major/minor as required intro course"] },
    ],
    "Physics": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Physical Science", "Life Science"], notes: ["No course equivalent", "Cannot count toward Physics or Chemistry major/minor"] },
    ],
    "Portuguese A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent"] },
    ],
    "Portuguese B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["PORT-UA 3", "PORT-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam to register"] },
    ],
    "Psychology": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["PSYCH-UA 1"], notes: ["4 of 8 credits count toward Psych major/minor", "Other 4 credits cannot apply to major/minor"] },
    ],
    "Social and Cultural Anthropology": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["ANTH-UA 1"], notes: ["4 of 8 credits equivalent to ANTH-UA 1"] },
    ],
    "Russian A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent"] },
    ],
    "Russian B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["RUSSN-UA 3", "RUSSN-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam to register"] },
    ],
    "Spanish A": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "Spanish B": [
        { scores: [6, 7], credits: 8, nyuEquivalent: ["SPAN-UA 3", "SPAN-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Non-natives may register for SPAN-UA 50; in-class exam on first day may result in lower placement and loss of credit", "Scores > 18 months old cannot be used for placement"] },
    ],
    "Turkish A or B": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "Urdu A or B": [
        { scores: [6, 7], credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
};

// ---- A-Level Equivalencies ----
// Source: "A Level Equivalencies (with Pre-U)" table + footnotes (lines 357-450)
// All A Level: minimum score B (Pre-U: M2), 8 credits each.
// Score is a string grade (e.g., "B", "A").

interface ALevelEntry {
    minScore: string; // "B" for standard, "A" for special cases
    credits: number;
    nyuEquivalent?: string[];
    coreSatisfaction?: string[];
    notes?: string[];
}

const ALEVEL_TABLE: Record<string, ALevelEntry[]> = {
    "Afrikaans": [
        { minScore: "B", credits: 8, notes: ["No course equivalent"] },
    ],
    "Arabic": [
        { minScore: "B", credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "Art, History of": [
        { minScore: "B", credits: 8, notes: ["Score B: does not count toward Art History major/minor; 8 elective ARTH-UA credits"] },
        { minScore: "A", credits: 8, nyuEquivalent: ["ARTH-UA 10"], notes: ["Score A: Art History majors exempt from ARTH-UA 10; 4 credits toward major, 4 as elective", "Never counts toward the minor"] },
    ],
    "Biology": [
        { minScore: "B", credits: 8, nyuEquivalent: ["BIOL-UA 11", "BIOL-UA 12"], coreSatisfaction: ["Physical Science", "Life Science"], notes: ["Prehealth cannot place out of BIOL-UA 11/12", "Non-prehealth should consult Bio dept"] },
    ],
    "Chemistry": [
        { minScore: "B", credits: 8, nyuEquivalent: ["CHEM-UA 125", "CHEM-UA 126"], coreSatisfaction: ["Physical Science", "Life Science"], notes: ["Does not count toward Bio/Chem majors or minors", "Prehealth cannot place out of CHEM-UA 125/126", "Not equivalent to CHEM-UA 129"] },
    ],
    "Chinese": [
        { minScore: "B", credits: 8, nyuEquivalent: ["EAST-UA 203", "EAST-UA 204"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam", "Cannot apply to East Asian Studies major/minor"] },
    ],
    "Classical Greek": [
        { minScore: "B", credits: 8, nyuEquivalent: ["CLASS-UA 9", "CLASS-UA 10"], coreSatisfaction: ["Foreign Language"], notes: ["Consult Classics dept for placement", "Cannot count toward Classics major/minor"] },
    ],
    "Classical Studies": [
        { minScore: "B", credits: 8, notes: ["No course equivalent", "Consult Classics DUS about possible major/minor credit"] },
    ],
    "Computer Science": [
        { minScore: "B", credits: 8, nyuEquivalent: ["CSCI-UA 101", "CSCI-UA 102"], notes: ["Must consult CS department about counting toward major/minor"] },
    ],
    "Economics": [
        { minScore: "B", credits: 8, nyuEquivalent: ["ECON-UA 1", "ECON-UA 2"], notes: ["Satisfies intro requirements for Econ major/minor, IR major, Business Studies minor"] },
    ],
    "English Literature": [
        { minScore: "B", credits: 8, notes: ["No course equivalent", "No credit for English Language exam"] },
    ],
    "French": [
        { minScore: "B", credits: 8, nyuEquivalent: ["FREN-UA 11", "FREN-UA 12"], coreSatisfaction: ["Foreign Language"] },
    ],
    "German": [
        { minScore: "B", credits: 8, nyuEquivalent: ["GERM-UA 3", "GERM-UA 4"], coreSatisfaction: ["Foreign Language"] },
    ],
    "Government and Politics": [
        { minScore: "B", credits: 8, notes: ["No course equivalent", "Max 8 credits toward Politics major, 4 toward minor; generic POL-UA credit"] },
    ],
    "Hindi": [
        { minScore: "B", credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "History": [
        { minScore: "B", credits: 8, notes: ["No course equivalent", "Max 4 of 8 credits toward History major; not for minor"] },
    ],
    "Italian": [
        { minScore: "B", credits: 8, nyuEquivalent: ["ITAL-UA 11", "ITAL-UA 12"], coreSatisfaction: ["Foreign Language"] },
    ],
    "Latin": [
        { minScore: "B", credits: 8, nyuEquivalent: ["CLASS-UA 5", "CLASS-UA 6"], coreSatisfaction: ["Foreign Language"], notes: ["Consult Classics dept for placement", "Cannot count toward Classics major/minor"] },
    ],
    "Mathematics": [
        { minScore: "B", credits: 8, nyuEquivalent: ["MATH-UA 121"], coreSatisfaction: ["Quantitative Reasoning"], notes: ["4 of 8 credits equivalent to MATH-UA 121", "Econ majors cannot use for MATH-UA 131/132/133", "For Further/Pure Maths, consult Math dept for equivalencies"] },
    ],
    "Philosophy": [
        { minScore: "B", credits: 8, notes: ["Score B: does not count toward Philosophy major/minor"] },
        { minScore: "A", credits: 8, nyuEquivalent: ["PHIL-UA 1"], notes: ["Score A: 4 of 8 credits count toward Philosophy major/minor as required intro course"] },
    ],
    "Physics": [
        { minScore: "B", credits: 8, coreSatisfaction: ["Physical Science", "Life Science"], notes: ["No course equivalent", "Cannot count toward Physics or Chemistry major/minor"] },
    ],
    "Portuguese": [
        { minScore: "B", credits: 8, nyuEquivalent: ["PORT-UA 3", "PORT-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Must take CAS placement exam to register"] },
    ],
    "Psychology": [
        { minScore: "B", credits: 8, nyuEquivalent: ["PSYCH-UA 1"], notes: ["4 of 8 credits count toward Psych major/minor (exempt from PSYCH-UA 1)", "Other 4 credits cannot apply to major/minor"] },
    ],
    "Religious Studies": [
        { minScore: "B", credits: 8, notes: ["No course equivalent", "Cannot count toward Religious Studies major/minor"] },
    ],
    "Sociology": [
        { minScore: "B", credits: 8, notes: ["No course equivalent", "Majors need dept approval for 4 of 8 credits as elective toward major", "Cannot exempt from SOC-UA 1/2"] },
    ],
    "Spanish": [
        { minScore: "B", credits: 8, nyuEquivalent: ["SPAN-UA 3", "SPAN-UA 4"], coreSatisfaction: ["Foreign Language"], notes: ["Non-natives: in-class exam may result in lower placement and loss of credit", "Scores > 18 months old cannot be used for placement"] },
    ],
    "Statistics": [
        { minScore: "B", credits: 8, coreSatisfaction: ["Quantitative Reasoning"], notes: ["No course equivalent", "Does not count toward Econ, IR, Sociology majors or Business Studies minor", "Consult Math/Psych depts for possible course equivalency", "Cannot receive full 8 credits for each if presenting multiple A-Level math exams"] },
    ],
    "Tamil": [
        { minScore: "B", credits: 8, notes: ["No course equivalent"] },
    ],
    "Telugu": [
        { minScore: "B", credits: 8, notes: ["No course equivalent"] },
    ],
    "Urdu": [
        { minScore: "B", credits: 8, coreSatisfaction: ["Foreign Language"], notes: ["No course equivalent", "Must take CAS placement exam to register"] },
    ],
    "Marathi": [
        { minScore: "B", credits: 8, notes: ["No course equivalent"] },
    ],
};

// ---- Public API ----

/**
 * Resolve an exam result to its NYU credit equivalency.
 *
 * @param type - "ap", "ib", or "alevel"
 * @param exam - Exam name (case-insensitive, matched to table keys)
 * @param score - Numeric score (AP: 1-5, IB: 1-7) or letter grade (A-Level: "A", "B", etc.)
 * @returns ExamResult if the score qualifies, or null if no credit awarded
 */
export function resolveExamCredit(
    type: "ap" | "ib" | "alevel",
    exam: string,
    score: number | string
): ExamResult | null {
    switch (type) {
        case "ap":
            return resolveAP(exam, typeof score === "number" ? score : parseInt(score, 10));
        case "ib":
            return resolveIB(exam, typeof score === "number" ? score : parseInt(score, 10));
        case "alevel":
            return resolveALevel(exam, String(score));
        default:
            return null;
    }
}

function resolveAP(exam: string, score: number): ExamResult | null {
    const entries = findEntry(AP_TABLE, exam);
    if (!entries || entries.length === 0) return null;

    for (const entry of entries) {
        if (entry.scores.includes(score)) {
            return {
                credits: entry.credits,
                nyuEquivalent: entry.nyuEquivalent,
                coreSatisfaction: entry.coreSatisfaction,
                notes: entry.notes,
            };
        }
    }
    return null; // Score too low
}

function resolveIB(exam: string, score: number): ExamResult | null {
    const entries = findEntry(IB_TABLE, exam);
    if (!entries || entries.length === 0) return null;

    // IB entries may have score-specific results (e.g., Math 6 vs 7)
    // Try most specific first (single score), then broader ranges
    for (const entry of entries) {
        if (entry.scores.includes(score)) {
            return {
                credits: entry.credits,
                nyuEquivalent: entry.nyuEquivalent,
                coreSatisfaction: entry.coreSatisfaction,
                notes: entry.notes,
            };
        }
    }
    return null;
}

function resolveALevel(exam: string, grade: string): ExamResult | null {
    const entries = findEntry(ALEVEL_TABLE, exam);
    if (!entries || entries.length === 0) return null;

    const gradeRank = getALevelGradeRank(grade.toUpperCase());
    if (gradeRank < 0) return null; // Invalid grade

    // Check each entry — some exams have score-specific results (e.g., Art History B vs A)
    // Sort entries by minScore descending (A first, then B) to match highest first
    const sorted = [...entries].sort(
        (a, b) => getALevelGradeRank(b.minScore) - getALevelGradeRank(a.minScore)
    );

    for (const entry of sorted) {
        if (gradeRank >= getALevelGradeRank(entry.minScore)) {
            return {
                credits: entry.credits,
                nyuEquivalent: entry.nyuEquivalent,
                coreSatisfaction: entry.coreSatisfaction,
                notes: entry.notes,
            };
        }
    }
    return null;
}

/** Rank A-Level grades: A* > A > B > C > D > E */
function getALevelGradeRank(grade: string): number {
    const ranks: Record<string, number> = {
        "A*": 6, "A": 5, "B": 4, "C": 3, "D": 2, "E": 1,
    };
    return ranks[grade] ?? -1;
}

/** Case-insensitive key lookup */
function findEntry<T>(table: Record<string, T[]>, exam: string): T[] | undefined {
    // Try exact match first
    if (table[exam]) return table[exam];
    // Case-insensitive search
    const lowerExam = exam.toLowerCase();
    for (const key of Object.keys(table)) {
        if (key.toLowerCase() === lowerExam) return table[key];
    }
    return undefined;
}

// General rules exported for use in validators:
// Source: General rules for transfer credits.md lines 67-71
export const EXAM_GENERAL_RULES = {
    /** Max credits from any combination of AP/IB/A-Level/prior college coursework */
    maxAdvancedStandingCredits: 32,
    /** Cannot earn credit for same subject via AP + IB + A-Level */
    noDuplicateSubjectCredit: true,
    /** AP credit lost if student takes the equivalent course at NYU */
    apCreditLostIfEquivalentTaken: true,
    /** No credit for AP/IB tests taken after high school */
    noPostHighSchoolExamCredit: true,
    /** IB: only HL exams qualify */
    ibHLOnly: true,
    /** A-Level: no credit for AS-Level exams */
    noASLevelCredit: true,
    /** A-Level Singapore: only H2/H3 exams; no credit for both H2 and H3 in same subject */
    singaporeH2H3Only: true,
} as const;

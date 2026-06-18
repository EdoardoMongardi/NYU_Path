// @vitest-environment jsdom
// ============================================================
// H5.1 — ProfileRail render test (jsdom, @testing-library/react)
// ============================================================
// TDD: written alongside the new ProfileRail component (plan 36).
//
// ProfileRail is the RIGHT zone of the 3-zone shell. It replaces the
// heavyweight scheduleSidebar with a PROFILE-ONLY rail:
//   (1) SummaryCard DPR-derived fields (read-only, CORE RULE 14).
//   (2) the "↻ Update DPR" refresh control (the ONLY way to change the
//       authoritative plan — wired to onRefreshDpr).
//   (3) the scenarios list: a pinned "My Plan" committed anchor + one
//       row per proposed/whatif scenario (badge-colored), with a
//       per-row Compare affordance.
//   (4) the "only My Plan is saved / your DPR is never changed" note +
//       the account actions (delete / clear-all).
// It contains NO schedule grid, NO slot popover, NO review/preview card,
// and crucially NO what-if/scenario SPAWN control (what-ifs are
// chat-only — owner decision confirmed in plan 36).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ForwardSchedule, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import { createPlanStore, type Scenario } from "../app/chat/planState";
import ProfileRail from "../app/chat/ProfileRail";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal ForwardSchedule — only the fields SummaryCard / the rail read. */
function makeSchedule(tag: string): ForwardSchedule {
    return {
        state: "valid-clean",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        semesters: [],
        assumptions: [],
        balanceScore: 1.0,
        studentId: tag,
        homeSchoolId: "cas",
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        dprCourseHistoryHash: tag,
        computedAt: 0,
    } as unknown as ForwardSchedule;
}

/** A real-shaped DPR with the header / cumulative fields SummaryCard reads. */
function makeDpr(): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind: "dpr",
        header: { studentName: "Ada Lovelace", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
    } as unknown as DegreeProgressReport;
}

function makeStudent(): StudentProfile {
    return {
        id: "student-ada",
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    } as unknown as StudentProfile;
}

let seq = 0;
function makeProposedScenario(overrides: Partial<Scenario> = {}): Scenario {
    return {
        id: `sc-proposed-${seq++}`,
        kind: "proposed",
        label: "Drop CSCI-UA 102",
        schedule: makeSchedule("proposed"),
        verdict: "trade-offs",
        hedges: ["Assumes you can drop before the deadline."],
        pendingMutationId: `pmid-${seq}`,
        createdAt: seq * 1000,
        ...overrides,
    };
}

function makeWhatifScenario(overrides: Partial<Scenario> = {}): Scenario {
    return {
        id: `wi-${seq++}`,
        kind: "whatif",
        label: "Add Economics minor",
        schedule: makeSchedule("whatif"),
        verdict: "valid",
        createdAt: seq * 1000,
        ...overrides,
    };
}

/** Build a store pre-seeded with a committed schedule + one proposed + one whatif. */
function buildStore() {
    const committed = makeSchedule("committed");
    const store = createPlanStore({ forwardSchedule: committed });
    const proposed = makeProposedScenario();
    const whatif = makeWhatifScenario();
    store.addScenario(proposed);
    store.addScenario(whatif);
    // Keep "committed" active so the rail's active highlight starts on the anchor.
    store.setActive("committed");
    return { store, committed, proposed, whatif };
}

function defaultProps(store: ReturnType<typeof createPlanStore>) {
    return {
        student: makeStudent(),
        dpr: makeDpr(),
        planStore: store,
        onRefreshDpr: vi.fn(async () => {}),
        refreshing: false,
        onClearAll: vi.fn(async () => {}),
        onDeleteAccount: vi.fn(async () => {}),
        deletingAccount: false,
        onSelectScenario: vi.fn(),
        onCompareScenario: vi.fn(),
    };
}

// ---------------------------------------------------------------------------
// (1) SummaryCard DPR fields render
// ---------------------------------------------------------------------------

describe("ProfileRail — DPR-derived profile fields", () => {
    it("renders the SummaryCard student name from the DPR header", () => {
        const { store } = buildStore();
        render(<ProfileRail {...defaultProps(store)} />);
        // SummaryCard surfaces the DPR header name + programs / school.
        expect(screen.getByText(/Ada Lovelace/i)).toBeTruthy();
    });

    it("renders the read-only home-school field", () => {
        const { store } = buildStore();
        render(<ProfileRail {...defaultProps(store)} />);
        // SummaryCard uppercases the home school ("CAS").
        expect(screen.getByText(/CAS/i)).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// (2) Scenarios list: pinned My Plan + a row per scenario with badges
// ---------------------------------------------------------------------------

describe("ProfileRail — scenarios list", () => {
    it("renders the pinned My Plan committed anchor", () => {
        const { store } = buildStore();
        const { container } = render(<ProfileRail {...defaultProps(store)} />);
        const row = container.querySelector("[data-scenario-row='committed']");
        expect(row).not.toBeNull();
        expect(row?.textContent).toMatch(/My Plan/i);
        // committed badge present
        expect(within(row as HTMLElement).getByText(/committed/i)).toBeTruthy();
    });

    it("renders a row for the proposed scenario with the proposed badge", () => {
        const { store, proposed } = buildStore();
        const { container } = render(<ProfileRail {...defaultProps(store)} />);
        const row = container.querySelector(`[data-scenario-row='${proposed.id}']`);
        expect(row).not.toBeNull();
        expect(row?.textContent).toMatch(/Drop CSCI-UA 102/i);
        expect(within(row as HTMLElement).getByText(/proposed/i)).toBeTruthy();
    });

    it("renders a row for the whatif scenario with the what-if badge", () => {
        const { store, whatif } = buildStore();
        const { container } = render(<ProfileRail {...defaultProps(store)} />);
        const row = container.querySelector(`[data-scenario-row='${whatif.id}']`);
        expect(row).not.toBeNull();
        expect(row?.textContent).toMatch(/Economics minor/i);
        expect(within(row as HTMLElement).getByText(/what-if/i)).toBeTruthy();
    });

    it("marks the active scenario row", () => {
        const { store, whatif } = buildStore();
        store.setActive(whatif.id);
        const { container } = render(<ProfileRail {...defaultProps(store)} />);
        const row = container.querySelector(`[data-scenario-row='${whatif.id}']`) as HTMLElement;
        expect(row.getAttribute("aria-current")).toBe("true");
    });
});

// ---------------------------------------------------------------------------
// (3) Clicking a scenario row selects it
// ---------------------------------------------------------------------------

describe("ProfileRail — row selection", () => {
    it("clicking a scenario row calls onSelectScenario with its id", () => {
        const { store, proposed } = buildStore();
        const props = defaultProps(store);
        const { container } = render(<ProfileRail {...props} />);
        const rowBtn = container.querySelector(
            `[data-scenario-row='${proposed.id}'] [data-select]`,
        ) as HTMLElement;
        fireEvent.click(rowBtn);
        expect(props.onSelectScenario).toHaveBeenCalledWith(proposed.id);
    });

    it("clicking the My Plan row calls onSelectScenario with 'committed'", () => {
        const { store } = buildStore();
        const props = defaultProps(store);
        const { container } = render(<ProfileRail {...props} />);
        const rowBtn = container.querySelector(
            "[data-scenario-row='committed'] [data-select]",
        ) as HTMLElement;
        fireEvent.click(rowBtn);
        expect(props.onSelectScenario).toHaveBeenCalledWith("committed");
    });
});

// ---------------------------------------------------------------------------
// (4) Compare affordance per scenario row
// ---------------------------------------------------------------------------

describe("ProfileRail — compare affordance", () => {
    it("clicking the Compare affordance calls onCompareScenario with the row id", () => {
        const { store, proposed } = buildStore();
        const props = defaultProps(store);
        const { container } = render(<ProfileRail {...props} />);
        const compareBtn = container.querySelector(
            `[data-scenario-row='${proposed.id}'] [data-compare]`,
        ) as HTMLElement;
        expect(compareBtn).not.toBeNull();
        fireEvent.click(compareBtn);
        expect(props.onCompareScenario).toHaveBeenCalledWith(proposed.id);
    });

    it("the committed row has NO compare affordance (committed vs committed is invalid)", () => {
        const { store } = buildStore();
        const { container } = render(<ProfileRail {...defaultProps(store)} />);
        const committedCompare = container.querySelector(
            "[data-scenario-row='committed'] [data-compare]",
        );
        expect(committedCompare).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (5) DPR-refresh control + the "only My Plan is saved" note + account actions
// ---------------------------------------------------------------------------

describe("ProfileRail — profile-level concerns", () => {
    it("renders the ↻ Update DPR refresh control", () => {
        const { store } = buildStore();
        render(<ProfileRail {...defaultProps(store)} />);
        expect(screen.getByRole("button", { name: /update dpr/i })).toBeTruthy();
    });

    it("shows the busy label when refreshing", () => {
        const { store } = buildStore();
        const props = { ...defaultProps(store), refreshing: true };
        render(<ProfileRail {...props} />);
        expect(screen.getByText(/updating/i)).toBeTruthy();
    });

    it("renders the 'only My Plan is saved / your DPR is never changed' note", () => {
        const { store } = buildStore();
        render(<ProfileRail {...defaultProps(store)} />);
        // Reuse of the sidebar's wording: DPR never changed + only committed plan persists.
        expect(screen.getByText(/your dpr is never changed/i)).toBeTruthy();
    });

    it("renders the delete-account action wired to onDeleteAccount", () => {
        const { store } = buildStore();
        const props = defaultProps(store);
        render(<ProfileRail {...props} />);
        const del = screen.getByRole("button", { name: /delete my account/i });
        fireEvent.click(del);
        expect(props.onDeleteAccount).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// (6) NO what-if/scenario spawn control (what-ifs are chat-only)
// ---------------------------------------------------------------------------

describe("ProfileRail — no spawn control", () => {
    it("does NOT render a what-if / scenario creation control", () => {
        const { store } = buildStore();
        render(<ProfileRail {...defaultProps(store)} />);
        // No "+ New", no "what if" creation button, no "new scenario".
        expect(screen.queryByText(/new what.?if/i)).toBeNull();
        expect(screen.queryByText(/\+\s*new/i)).toBeNull();
        expect(screen.queryByText(/new scenario/i)).toBeNull();
        // The compare affordances are per-row and never create a scenario.
    });
});

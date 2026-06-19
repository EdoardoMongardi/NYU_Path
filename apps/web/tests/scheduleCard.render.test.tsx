// @vitest-environment jsdom
// ============================================================
// H4.1 — ScheduleCard render test (jsdom, @testing-library/react)
// ============================================================
// TDD RED phase: written BEFORE the component exists.
//
// Covers:
//   (1) renders the label + summary + correct badge for a `proposed` card.
//   (2) renders the label + summary + correct badge for a `whatif` card.
//   (3) Open button calls onOpen(scenarioId).
//   (4) Compare button calls onCompare(scenarioId).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ScheduleCard, { type ScheduleCardProps } from "../app/chat/ScheduleCard";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<ScheduleCardProps> = {}): ScheduleCardProps {
    return {
        scenarioId: "sc-test-001",
        kind: "proposed",
        label: "Withdraw MATH-UA 325",
        summary: "Re-opens Analysis requirement · retake Spring 2027",
        verdict: "trade-offs",
        onOpen: vi.fn(),
        onCompare: vi.fn(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// (1) Proposed card — label + summary + correct badge
// ---------------------------------------------------------------------------

describe("ScheduleCard — proposed kind", () => {
    it("renders the label", () => {
        render(<ScheduleCard {...makeProps()} />);
        expect(screen.getByText("Withdraw MATH-UA 325")).toBeTruthy();
    });

    it("renders the summary text", () => {
        render(<ScheduleCard {...makeProps()} />);
        expect(screen.getByText(/re-opens analysis requirement/i)).toBeTruthy();
    });

    it("renders a badge containing 'Proposed'", () => {
        const { container } = render(<ScheduleCard {...makeProps()} />);
        // Badge should be present and text should include "Proposed"
        const badge = container.querySelector("[data-kind='proposed']");
        expect(badge).not.toBeNull();
        expect(badge?.textContent).toMatch(/proposed/i);
    });

    it("renders the trade-offs verdict glyph ⚠", () => {
        render(<ScheduleCard {...makeProps({ verdict: "trade-offs" })} />);
        expect(screen.getByText(/⚠/)).toBeTruthy();
    });

    it("renders the valid verdict glyph ✓", () => {
        render(<ScheduleCard {...makeProps({ verdict: "valid" })} />);
        expect(screen.getByText(/✓/)).toBeTruthy();
    });

    it("renders the invalid verdict glyph ✗", () => {
        render(<ScheduleCard {...makeProps({ verdict: "invalid" })} />);
        expect(screen.getByText(/✗/)).toBeTruthy();
    });

    it("does NOT render a verdict glyph when verdict is omitted", () => {
        const props = makeProps();
        delete props.verdict;
        render(<ScheduleCard {...props} />);
        // None of the verdict glyphs should appear
        expect(screen.queryByText(/✓|⚠|✗/)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (2) What-if card — label + summary + correct badge
// ---------------------------------------------------------------------------

describe("ScheduleCard — whatif kind", () => {
    it("renders the label for a whatif card", () => {
        render(
            <ScheduleCard
                {...makeProps({
                    kind: "whatif",
                    label: "+ Economics minor",
                    summary: "Read-only exploration · adds 4 ECON courses",
                    verdict: "valid",
                })}
            />,
        );
        expect(screen.getByText("+ Economics minor")).toBeTruthy();
    });

    it("renders a badge containing 'What-if' for a whatif card", () => {
        const { container } = render(
            <ScheduleCard
                {...makeProps({
                    kind: "whatif",
                    label: "+ Economics minor",
                    verdict: "valid",
                })}
            />,
        );
        const badge = container.querySelector("[data-kind='whatif']");
        expect(badge).not.toBeNull();
        expect(badge?.textContent).toMatch(/what.?if/i);
    });

    it("renders the summary for a whatif card", () => {
        render(
            <ScheduleCard
                {...makeProps({
                    kind: "whatif",
                    summary: "Read-only exploration · adds 4 ECON courses",
                })}
            />,
        );
        expect(screen.getByText(/read-only exploration/i)).toBeTruthy();
    });

    it("omits the summary block when summary is not provided", () => {
        const props = makeProps({ kind: "whatif" });
        delete props.summary;
        render(<ScheduleCard {...props} />);
        // There should be no summary paragraph
        const summaryEl = document.querySelector("[data-testid='schedule-card-summary']");
        expect(summaryEl).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (3) Open button → calls onOpen(scenarioId)
// ---------------------------------------------------------------------------

describe("ScheduleCard — Open button", () => {
    it("renders an Open button", () => {
        render(<ScheduleCard {...makeProps()} />);
        expect(screen.getByRole("button", { name: /open/i })).toBeTruthy();
    });

    it("clicking Open calls onOpen with the scenarioId", () => {
        const onOpen = vi.fn();
        render(<ScheduleCard {...makeProps({ onOpen })} />);
        fireEvent.click(screen.getByRole("button", { name: /open/i }));
        expect(onOpen).toHaveBeenCalledOnce();
        expect(onOpen).toHaveBeenCalledWith("sc-test-001");
    });

    it("onOpen is NOT called before the button is clicked", () => {
        const onOpen = vi.fn();
        render(<ScheduleCard {...makeProps({ onOpen })} />);
        expect(onOpen).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// (4) Compare button → calls onCompare(scenarioId)
// ---------------------------------------------------------------------------

describe("ScheduleCard — Compare button", () => {
    it("renders a Compare button", () => {
        render(<ScheduleCard {...makeProps()} />);
        expect(screen.getByRole("button", { name: /compare/i })).toBeTruthy();
    });

    it("clicking Compare calls onCompare with the scenarioId", () => {
        const onCompare = vi.fn();
        render(<ScheduleCard {...makeProps({ onCompare })} />);
        fireEvent.click(screen.getByRole("button", { name: /compare/i }));
        expect(onCompare).toHaveBeenCalledOnce();
        expect(onCompare).toHaveBeenCalledWith("sc-test-001");
    });

    it("onCompare is NOT called before the button is clicked", () => {
        const onCompare = vi.fn();
        render(<ScheduleCard {...makeProps({ onCompare })} />);
        expect(onCompare).not.toHaveBeenCalled();
    });
});

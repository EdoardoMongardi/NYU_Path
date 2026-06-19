// @vitest-environment jsdom
// ============================================================
// F2 — SlotActionPopover render test (jsdom, @testing-library/react)
// ============================================================
// TDD: written BEFORE SlotActionPopover.tsx exists.
//
// Covers:
//   (1) renders one button per item in the provided items list.
//   (2) a disabled item renders with the HTML `disabled` attribute
//       and its tooltip as the `title` attribute.
//   (3) clicking an enabled item calls onAction with the item's action.
//   (4) clicking the close (✕) control calls onClose.
//   (5) an enabled item with a tooltip exposes it as `title`.
//   (6) an enabled item without a tooltip has no `title`.
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SlotAction } from "@nyupath/engine";
import type { SlotActionViewItem } from "../app/chat/workspace/slotActionView";
import SlotActionPopover from "../app/chat/workspace/SlotActionPopover";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEMS: SlotActionViewItem[] = [
    { action: "drop",     label: "Drop",      enabled: true,  tooltip: undefined },
    { action: "withdraw", label: "Withdraw",  enabled: true,  tooltip: "check the deadline" },
    { action: "passFail", label: "Pass/Fail", enabled: false, tooltip: "can't elect" },
];

// ---------------------------------------------------------------------------
// (1) One button per item
// ---------------------------------------------------------------------------

describe("SlotActionPopover — button count", () => {
    it("renders one action button per item", () => {
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={vi.fn()}
                onClose={vi.fn()}
            />
        );
        // getByText throws if not found — asserting presence without jest-dom
        expect(screen.getByText("Drop")).toBeTruthy();
        expect(screen.getByText("Withdraw")).toBeTruthy();
        expect(screen.getByText("Pass/Fail")).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// (2) Disabled item renders disabled + title=tooltip
// ---------------------------------------------------------------------------

describe("SlotActionPopover — disabled state", () => {
    it("Pass/Fail button is disabled and has title='can't elect'", () => {
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={vi.fn()}
                onClose={vi.fn()}
            />
        );
        const pfBtn = screen.getByText("Pass/Fail").closest("button") as HTMLButtonElement;
        expect(pfBtn).toBeDefined();
        expect(pfBtn.disabled).toBe(true);
        expect(pfBtn.title).toBe("can't elect");
    });
});

// ---------------------------------------------------------------------------
// (3) Clicking an enabled item calls onAction with the correct action
// ---------------------------------------------------------------------------

describe("SlotActionPopover — onAction callback", () => {
    it("clicking Withdraw calls onAction('withdraw')", () => {
        const onAction = vi.fn();
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={onAction}
                onClose={vi.fn()}
            />
        );
        fireEvent.click(screen.getByText("Withdraw"));
        expect(onAction).toHaveBeenCalledWith("withdraw");
    });

    it("clicking Drop calls onAction('drop')", () => {
        const onAction = vi.fn();
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={onAction}
                onClose={vi.fn()}
            />
        );
        fireEvent.click(screen.getByText("Drop"));
        expect(onAction).toHaveBeenCalledWith("drop");
    });
});

// ---------------------------------------------------------------------------
// (4) Clicking the close control calls onClose
// ---------------------------------------------------------------------------

describe("SlotActionPopover — onClose callback", () => {
    it("clicking the close button calls onClose", () => {
        const onClose = vi.fn();
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={vi.fn()}
                onClose={onClose}
            />
        );
        // The close button has aria-label="Close" or contains ✕
        const closeBtn = screen.getByRole("button", { name: /close/i });
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// (5) Enabled item with tooltip exposes title
// ---------------------------------------------------------------------------

describe("SlotActionPopover — enabled tooltip", () => {
    it("Withdraw (enabled, tooltip='check the deadline') has title set", () => {
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={vi.fn()}
                onClose={vi.fn()}
            />
        );
        const withdrawBtn = screen.getByText("Withdraw").closest("button") as HTMLButtonElement;
        expect(withdrawBtn.title).toBe("check the deadline");
    });
});

// ---------------------------------------------------------------------------
// (6) Enabled item without tooltip has no title attribute
// ---------------------------------------------------------------------------

describe("SlotActionPopover — no tooltip → no title", () => {
    it("Drop (enabled, no tooltip) has no title attribute", () => {
        render(
            <SlotActionPopover
                items={ITEMS}
                onAction={vi.fn()}
                onClose={vi.fn()}
            />
        );
        const dropBtn = screen.getByText("Drop").closest("button") as HTMLButtonElement;
        // title should be absent or empty string (not set = "")
        expect(dropBtn.title).toBeFalsy();
    });
});

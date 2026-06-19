// @vitest-environment jsdom
// ============================================================
// H4.2b-3 — WhatIfUploadCard render test (jsdom, @testing-library/react)
// ============================================================
// TDD: covers the Branch-A "explore precisely" upload offer card.
//
// Covers:
//   (1) renders the hypothetical-program label + an Upload button.
//   (2) clicking Upload triggers the hidden file input.
//   (3) onUpload fires with the chosen File.
//   (4) `uploading` shows a spinner + disables the button.
//   (5) `error` text is shown.
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WhatIfUploadCard, { type WhatIfUploadCardProps } from "../app/chat/WhatIfUploadCard";

afterEach(() => cleanup());

function makeProps(overrides: Partial<WhatIfUploadCardProps> = {}): WhatIfUploadCardProps {
    return {
        hypotheticalProgram: "Economics (BA)",
        onUpload: vi.fn(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// (1) renders the program label + Upload button
// ---------------------------------------------------------------------------

describe("WhatIfUploadCard", () => {
    it("renders the hypothetical-program label and an Upload button", () => {
        render(<WhatIfUploadCard {...makeProps()} />);
        // The program label appears in the body text.
        expect(screen.getByText(/Economics \(BA\)/)).toBeTruthy();
        // An enabled Upload button.
        const btn = screen.getByRole("button", { name: /upload albert what-if audit/i });
        expect(btn).toBeTruthy();
        expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    // -----------------------------------------------------------------------
    // (2) + (3) clicking Upload opens the file input; onUpload fires with the File
    // -----------------------------------------------------------------------

    it("triggers the hidden file input on click and fires onUpload with the chosen File", () => {
        const onUpload = vi.fn();
        const { container } = render(<WhatIfUploadCard {...makeProps({ onUpload })} />);

        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput).toBeTruthy();
        // The button click delegates to the hidden input's .click().
        const clickSpy = vi.spyOn(fileInput, "click");
        fireEvent.click(screen.getByRole("button", { name: /upload albert what-if audit/i }));
        expect(clickSpy).toHaveBeenCalled();

        // Choosing a file fires onUpload with that File.
        const pdf = new File(["%PDF-1.4 fake"], "whatif.pdf", { type: "application/pdf" });
        fireEvent.change(fileInput, { target: { files: [pdf] } });
        expect(onUpload).toHaveBeenCalledTimes(1);
        expect(onUpload.mock.calls[0][0]).toBe(pdf);
    });

    // -----------------------------------------------------------------------
    // (4) uploading → spinner + disabled
    // -----------------------------------------------------------------------

    it("shows a spinner and disables the button while uploading", () => {
        render(<WhatIfUploadCard {...makeProps({ uploading: true })} />);
        const btn = screen.getByRole("button", { name: /upload albert what-if audit/i });
        expect((btn as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("whatif-upload-spinner")).toBeTruthy();
    });

    // -----------------------------------------------------------------------
    // (5) error text is shown
    // -----------------------------------------------------------------------

    it("shows the error text when present", () => {
        render(
            <WhatIfUploadCard
                {...makeProps({ error: "Upload failed. Please try again." })}
            />,
        );
        expect(screen.getByText("Upload failed. Please try again.")).toBeTruthy();
    });
});

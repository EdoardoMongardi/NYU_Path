import { describe, it, expect } from "vitest";
import { formatDuration } from "../lib/formatDuration";

describe("formatDuration", () => {
    it("returns sub-second values in ms", () => {
        expect(formatDuration(0)).toBe("0ms");
        expect(formatDuration(450)).toBe("450ms");
        expect(formatDuration(999)).toBe("999ms");
    });

    it("returns 1 decimal place between 1s and 9.9s", () => {
        expect(formatDuration(1000)).toBe("1.0s");
        expect(formatDuration(1234)).toBe("1.2s");
        expect(formatDuration(4670)).toBe("4.7s");
        expect(formatDuration(9900)).toBe("9.9s");
    });

    it("returns whole seconds between 10s and 59s", () => {
        expect(formatDuration(10000)).toBe("10s");
        expect(formatDuration(45499)).toBe("45s");
        expect(formatDuration(59999)).toBe("60s");
    });

    it("returns minutes + seconds beyond 60s", () => {
        expect(formatDuration(60000)).toBe("1m 0s");
        expect(formatDuration(64500)).toBe("1m 5s");
        expect(formatDuration(125000)).toBe("2m 5s");
    });

    it("clamps negative input to 0ms", () => {
        expect(formatDuration(-50)).toBe("0ms");
    });
});

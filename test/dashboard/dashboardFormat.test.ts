import { describe, expect, it } from "vitest";
import { formatValue, NO_VALUE } from "../../src/webviews/pages/Dashboard/dashboardFormat";

const number = { format: "number", unit: "" } as const;
const rate = { format: "number", unit: "/s" } as const;
const bytesRate = { format: "bytes", unit: "/s" } as const;
const percent = { format: "percent", unit: "%" } as const;

describe("formatValue", () => {
    it("writes a missing value as a dash, never as zero", () => {
        expect(formatValue(null, number)).toBe(NO_VALUE);
        expect(formatValue(undefined, rate)).toBe(NO_VALUE);
        expect(formatValue(Number.NaN, rate)).toBe(NO_VALUE);
        expect(formatValue(0, rate, "en-US")).toBe("0/s");
    });

    it("writes numbers with separators, few decimals, and compact when large", () => {
        expect(formatValue(1234, number, "en-US")).toBe("1,234");
        expect(formatValue(3.14159, rate, "en-US")).toBe("3.14/s");
        expect(formatValue(42.25, rate, "en-US")).toBe("42.3/s");
        expect(formatValue(123456, rate, "en-US")).toBe("123.5K/s");
        expect(formatValue(300, { format: "number", unit: " s" }, "en-US")).toBe("300 s");
    });

    it("writes sizes in binary units", () => {
        expect(formatValue(512, bytesRate, "en-US")).toBe("512 B/s");
        expect(formatValue(1536, bytesRate, "en-US")).toBe("1.5 KB/s");
        expect(formatValue(5 * 1024 * 1024, bytesRate, "en-US")).toBe("5 MB/s");
        expect(formatValue(300 * 1024 ** 3, bytesRate, "en-US")).toBe("300 GB/s");
    });

    it("writes percentages once, whether the unit says % or not", () => {
        expect(formatValue(99.95, percent, "en-US")).toBe("99.95%");
        expect(formatValue(87.251, percent, "en-US")).toBe("87.25%");
        expect(formatValue(50, { format: "percent", unit: "" }, "en-US")).toBe("50%");
    });
});

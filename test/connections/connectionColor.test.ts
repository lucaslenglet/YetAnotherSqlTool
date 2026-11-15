import { describe, expect, it } from "vitest";
import {
    parseConnectionColor,
    resolveConnectionColor,
} from "../../src/connections/connectionColor";

describe("parseConnectionColor", () => {
    it("accepts # followed by 6 hex digits, in either case", () => {
        expect(parseConnectionColor("#C50F1F")).toBe("#c50f1f");
        expect(parseConnectionColor("#00cc6a")).toBe("#00cc6a");
    });

    it("ignores anything else", () => {
        for (const value of [
            undefined,
            null,
            "",
            "red",
            "#fff",
            "c50f1f",
            "#c50f1f00",
            "#c50f1g",
            " #c50f1f",
            42,
        ]) {
            expect(parseConnectionColor(value), String(value)).toBeUndefined();
        }
    });
});

describe("resolveConnectionColor", () => {
    const saved = [
        { id: "prod", color: "#C50F1F" },
        { id: "dev" },
        { id: "broken", color: "not a color" },
    ];

    it("takes the color of the saved profile with the same id over the snapshot", () => {
        expect(resolveConnectionColor({ id: "prod", color: "#107c10" }, saved)).toBe("#c50f1f");
    });

    it("has no color when the saved profile has none, whatever the snapshot says", () => {
        expect(resolveConnectionColor({ id: "dev", color: "#107c10" }, saved)).toBeUndefined();
    });

    it("falls back to the snapshot when no saved profile has its id", () => {
        expect(resolveConnectionColor({ id: "gone", color: "#107C10" }, saved)).toBe("#107c10");
        expect(resolveConnectionColor({ color: "#107c10" }, saved)).toBe("#107c10");
    });

    it("ignores an invalid color", () => {
        expect(resolveConnectionColor({ id: "broken" }, saved)).toBeUndefined();
        expect(resolveConnectionColor({ color: "blue" }, [])).toBeUndefined();
    });
});

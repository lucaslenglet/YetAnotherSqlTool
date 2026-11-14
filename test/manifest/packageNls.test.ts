import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const nls: Record<string, string> = JSON.parse(
    readFileSync(resolve(root, "package.nls.json"), "utf8"),
);

/** Collects every `%key%` placeholder used by a manifest value. */
function placeholders(value: unknown, found = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        const match = /^%([^%]+)%$/.exec(value);
        if (match) {
            found.add(match[1]);
        }
    } else if (Array.isArray(value)) {
        value.forEach((v) => placeholders(v, found));
    } else if (value && typeof value === "object") {
        Object.values(value).forEach((v) => placeholders(v, found));
    }
    return found;
}

describe("package.nls.json", () => {
    const used = placeholders(manifest);

    it("defines every %key% referenced by package.json", () => {
        expect([...used].filter((key) => !(key in nls))).toEqual([]);
    });

    it("has no key that package.json does not use", () => {
        expect(Object.keys(nls).filter((key) => !used.has(key))).toEqual([]);
    });

    it("has only non-empty string values", () => {
        expect(Object.entries(nls).filter(([, v]) => typeof v !== "string" || v === "")).toEqual(
            [],
        );
    });
});

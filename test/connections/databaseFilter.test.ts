import { describe, expect, it } from "vitest";
import { createDatabaseFilter } from "../../src/connections/databaseFilter";

const databases = ["shop-dev-eu", "shop-rec-eu", "Billing-DEV-us", "billing-prod", "a.b", "axb"];
const shown = (filter: string) => databases.filter(createDatabaseFilter(filter));

describe("createDatabaseFilter", () => {
    it("is undefined when the profile has no pattern", () => {
        expect(createDatabaseFilter(undefined)).toBeUndefined();
        expect(createDatabaseFilter("")).toBeUndefined();
        expect(createDatabaseFilter(" ; , ! ")).toBeUndefined();
    });

    it("keeps the databases matching a pattern, ignoring case", () => {
        expect(shown("*-dev-*")).toEqual(["shop-dev-eu", "Billing-DEV-us"]);
        expect(shown("*-rec-*")).toEqual(["shop-rec-eu"]);
    });

    it("matches the whole name", () => {
        expect(shown("billing")).toEqual([]);
        expect(shown("billing-prod")).toEqual(["billing-prod"]);
        expect(shown("shop-???-eu")).toEqual(["shop-dev-eu", "shop-rec-eu"]);
    });

    it("accepts several patterns separated by ; or ,", () => {
        expect(shown("*-rec-*; billing-prod")).toEqual(["shop-rec-eu", "billing-prod"]);
        expect(shown("*-rec-*,billing-prod")).toEqual(["shop-rec-eu", "billing-prod"]);
    });

    it("hides the databases matching a ! pattern", () => {
        expect(shown("!*-prod")).toEqual([
            "shop-dev-eu",
            "shop-rec-eu",
            "Billing-DEV-us",
            "a.b",
            "axb",
        ]);
        expect(shown("shop-*; !*-rec-*")).toEqual(["shop-dev-eu"]);
    });

    it("takes every other character literally", () => {
        expect(shown("a.b")).toEqual(["a.b"]);
        expect(shown("[a-z]*")).toEqual([]);
    });
});

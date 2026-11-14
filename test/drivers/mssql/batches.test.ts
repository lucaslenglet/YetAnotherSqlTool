import { describe, expect, it } from "vitest";
import { splitBatches } from "../../../src/drivers/mssql/batches";

describe("splitBatches", () => {
    it("returns one batch when there is no GO", () => {
        expect(splitBatches("SELECT 1\nSELECT 2")).toEqual([
            { text: "SELECT 1\nSELECT 2", startLine: 0 },
        ]);
    });

    it("splits on GO lines and reports the 0-based start line of each batch", () => {
        const script = "SELECT 1\nGO\nSELECT 2\nSELECT 3\ngo\n\nSELECT 4";
        expect(splitBatches(script)).toEqual([
            { text: "SELECT 1", startLine: 0 },
            { text: "SELECT 2\nSELECT 3", startLine: 2 },
            { text: "\nSELECT 4", startLine: 5 },
        ]);
    });

    it("is case insensitive and tolerates spaces and a trailing comment", () => {
        const script = "A\n  Go  \nB\nGO -- end of B\nC";
        expect(splitBatches(script).map((b) => b.text)).toEqual(["A", "B", "C"]);
    });

    it("repeats a batch when GO has a count", () => {
        const batches = splitBatches("INSERT x\nGO 3\nSELECT 1");
        expect(batches.map((b) => b.text)).toEqual([
            "INSERT x",
            "INSERT x",
            "INSERT x",
            "SELECT 1",
        ]);
        expect(batches.map((b) => b.startLine)).toEqual([0, 0, 0, 2]);
    });

    it("ignores empty batches", () => {
        expect(splitBatches("GO\n\nGO\n  \nSELECT 1\nGO\nGO")).toEqual([
            { text: "  \nSELECT 1", startLine: 3 },
        ]);
        expect(splitBatches("")).toEqual([]);
    });

    it("does not treat words that merely start with GO, or GO with other text, as separators", () => {
        const script = "GOTO label\nGO TO label\nGOSUB\nSELECT 1 GO";
        expect(splitBatches(script)).toHaveLength(1);
    });

    it("does not split inside string literals", () => {
        const script = "SELECT 'first line\nGO\nlast line'\nGO\nSELECT 2";
        expect(splitBatches(script).map((b) => b.text)).toEqual([
            "SELECT 'first line\nGO\nlast line'",
            "SELECT 2",
        ]);
    });

    it("understands doubled quotes inside strings", () => {
        const script = "SELECT 'it''s\nGO\nstill a string'\nGO\nSELECT 2";
        expect(splitBatches(script)).toHaveLength(2);
    });

    it("does not split inside quoted or bracketed identifiers", () => {
        expect(splitBatches('SELECT "a\nGO\nb"\nGO\nSELECT 2')).toHaveLength(2);
        expect(splitBatches("SELECT [a\nGO\nb]\nGO\nSELECT 2")).toHaveLength(2);
        expect(splitBatches("SELECT [a]]\nGO\nb]\nGO\nSELECT 2")).toHaveLength(2);
    });

    it("does not split inside block comments, including nested and multi-line ones", () => {
        const script = "/* start\nGO\n/* nested\nGO\n*/\nGO\n*/\nSELECT 1\nGO\nSELECT 2";
        const batches = splitBatches(script);
        expect(batches).toHaveLength(2);
        expect(batches[1]).toEqual({ text: "SELECT 2", startLine: 9 });
    });

    it("ignores quotes and comment markers that sit inside line comments", () => {
        const script = "SELECT 1 -- it's /* not a string or comment\nGO\nSELECT 2";
        expect(splitBatches(script).map((b) => b.text)).toEqual([
            "SELECT 1 -- it's /* not a string or comment",
            "SELECT 2",
        ]);
    });

    it("keeps Windows line endings in the batch text and still finds GO", () => {
        const batches = splitBatches("SELECT 1\r\nGO\r\nSELECT 2\r\n");
        expect(batches.map((b) => b.text)).toEqual(["SELECT 1\r", "SELECT 2\r\n"]);
    });
});

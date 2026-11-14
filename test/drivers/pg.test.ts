import { describe, expect, it } from "vitest";
import { pgDriver } from "../../src/drivers/pg";

describe("driver basics", () => {
    it("describes connection options like the mssql capabilities", () => {
        const { options: list, groupDisplayNames } = pgDriver.getConnectionOptions();
        expect(Object.keys(groupDisplayNames)).toEqual([
            "general",
            "security",
            "resiliency",
            "context",
        ]);
        expect(list.map((o) => o.name)).toEqual([
            "server",
            "port",
            "database",
            "authenticationType",
            "user",
            "clientId",
            "password",
            "applicationName",
            "sslmode",
            "sslrootcert",
            "connectTimeout",
            "commandTimeout",
            "searchPath",
        ]);
        expect(list.find((o) => o.name === "port")?.defaultValue).toBe("5432");
        expect(
            list.find((o) => o.name === "authenticationType")?.categoryValues.map((c) => c.name),
        ).toEqual([
            "SqlLogin",
            "AzureMFA",
            "ActiveDirectoryDefault",
            "ActiveDirectoryServicePrincipal",
        ]);
        expect(list.every((o) => groupDisplayNames[o.groupName])).toBe(true);
    });

    it("quotes identifiers and literals", () => {
        const text = { columnName: "c", dataTypeName: "text", kind: "string" as const };
        const lit = (
            displayValue: string,
            kind: "string" | "number" | "boolean" | "binary" | "datetime",
            isNull = false,
        ) => pgDriver.toSqlLiteral({ displayValue, isNull }, { ...text, kind });
        expect(pgDriver.quoteIdentifier('we"ird')).toBe('"we""ird"');
        expect(lit("NULL", "string", true)).toBe("NULL");
        expect(lit("12.50", "number")).toBe("12.50");
        expect(lit("NaN", "number")).toBe("'NaN'");
        expect(lit("true", "boolean")).toBe("TRUE");
        expect(lit("false", "boolean")).toBe("FALSE");
        expect(lit("O'Neil", "string")).toBe("'O''Neil'");
        expect(lit("\\xdeadbeef", "binary")).toBe("'\\xdeadbeef'::bytea");
        expect(lit("2024-03-05", "datetime")).toBe("'2024-03-05'");
    });

    it("returns one batch for a script, none for blank text", () => {
        expect(pgDriver.splitBatches("  \n ")).toEqual([]);
        expect(pgDriver.splitBatches("SELECT 1;\nSELECT 2;")).toEqual([
            { text: "SELECT 1;\nSELECT 2;", startLine: 0 },
        ]);
    });
});

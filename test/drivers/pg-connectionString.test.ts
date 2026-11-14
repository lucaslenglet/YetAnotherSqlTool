import { describe, expect, it } from "vitest";
import {
    buildConnectionString,
    parseConnectionString,
} from "../../src/drivers/pg/connectionString";

const base = { authenticationType: "SqlLogin" };

describe("pg parseConnectionString: keyword/value", () => {
    it("maps libpq keywords to option names", () => {
        expect(
            parseConnectionString(
                "host=db.example.com port=5433 dbname=app user=bob password=secret sslmode=verify-full sslrootcert=/ca.pem application_name=yast connect_timeout=10",
            ),
        ).toEqual({
            ...base,
            server: "db.example.com",
            port: 5433,
            database: "app",
            user: "bob",
            password: "secret",
            sslmode: "verify-full",
            sslrootcert: "/ca.pem",
            applicationName: "yast",
            connectTimeout: 10,
        });
    });

    it("handles quotes, backslashes and spaces around =", () => {
        expect(parseConnectionString("host = x password='a b' user=o\\ k")).toMatchObject({
            server: "x",
            password: "a b",
            user: "o k",
        });
        expect(parseConnectionString("password='it\\'s \\\\ ok'").password).toBe("it's \\ ok");
        expect(parseConnectionString("host=x password=''").password).toBeUndefined();
        expect(parseConnectionString("HOST=X\nPORT=1").port).toBe(1);
    });

    it("extracts search_path and statement_timeout from options", () => {
        expect(
            parseConnectionString(
                "host=x options='-c search_path=app,\\\\ public -c statement_timeout=5000'",
            ),
        ).toMatchObject({
            searchPath: "app, public",
            commandTimeout: 5,
        });
        expect(parseConnectionString("host=x options=--search_path=a").searchPath).toBe("a");
        expect(parseConnectionString("host=x options=-csearch_path=b").searchPath).toBe("b");
    });

    it("ignores unknown keys and keeps the first host of a list", () => {
        expect(
            parseConnectionString("host=a,b port=1,2 gssencmode=disable target_session_attrs=any"),
        ).toEqual({ ...base, server: "a", port: 1 });
    });

    it("throws readable errors", () => {
        expect(() => parseConnectionString("")).toThrow(/empty/);
        expect(() => parseConnectionString("host")).toThrow(/missing "="/);
        expect(() => parseConnectionString("host=x password='abc")).toThrow(/not closed/);
        expect(() => parseConnectionString("host=x sslmode=sure")).toThrow(/sslmode/);
        expect(() => parseConnectionString("host=x port=abc")).toThrow(/port/);
        expect(() => parseConnectionString("host=x port=70000")).toThrow(/port/);
        expect(() => parseConnectionString("host=x connect_timeout=soon")).toThrow(
            /connect_timeout/,
        );
    });
});

describe("pg parseConnectionString: URI", () => {
    it("parses a full URI with percent-decoding", () => {
        expect(
            parseConnectionString(
                "postgresql://bob:p%40ss%3Aw%2Frd@db.example.com:5433/my%20db?sslmode=require&application_name=a+b&connect_timeout=3",
            ),
        ).toEqual({
            ...base,
            server: "db.example.com",
            port: 5433,
            database: "my db",
            user: "bob",
            password: "p@ss:w/rd",
            sslmode: "require",
            applicationName: "a b",
            connectTimeout: 3,
        });
    });

    it("accepts postgres://, IPv6, missing parts and parameters instead of path", () => {
        expect(parseConnectionString("postgres://[::1]:6000/d")).toMatchObject({
            server: "::1",
            port: 6000,
            database: "d",
        });
        expect(parseConnectionString("postgres://[::1]/")).toEqual({ ...base, server: "::1" });
        expect(parseConnectionString("postgresql://host")).toEqual({ ...base, server: "host" });
        expect(parseConnectionString("postgresql://u@/db?host=/var/run/postgresql")).toMatchObject({
            server: "/var/run/postgresql",
            user: "u",
            database: "db",
        });
        expect(parseConnectionString("postgresql://a:1,b:2/db")).toMatchObject({
            server: "a",
            port: 1,
        });
        expect(parseConnectionString("postgresql://h?options=-c%20search_path%3Dx")).toMatchObject({
            searchPath: "x",
        });
    });

    it("throws on malformed URIs", () => {
        expect(() => parseConnectionString("postgresql://[::1/db")).toThrow(/\]/);
        expect(() => parseConnectionString("postgresql://h/db?novalue")).toThrow(/query parameter/);
        expect(() => parseConnectionString("postgresql://u%zz@h")).toThrow(/percent/);
    });
});

describe("pg buildConnectionString", () => {
    const options = {
        authenticationType: "SqlLogin",
        server: "h",
        port: 5432,
        database: "app",
        user: "bob",
        password: "it's a \\ secret",
        sslmode: "require",
        applicationName: "my app",
        connectTimeout: 15,
        searchPath: "app, public",
        commandTimeout: 5,
    };

    it("builds libpq keyword/value text and quotes when needed", () => {
        expect(buildConnectionString(options, true)).toBe(
            "host=h port=5432 dbname=app user=bob password='it\\'s a \\\\ secret' sslmode=require application_name='my app' connect_timeout=15 " +
                "options='-c search_path=app,\\\\ public -c statement_timeout=5000'",
        );
    });

    it("omits the password unless asked, and unset options", () => {
        expect(buildConnectionString(options, false)).not.toContain("password");
        expect(buildConnectionString({ server: "h", database: "", port: undefined }, true)).toBe(
            "host=h",
        );
    });

    it("round trips", () => {
        expect(parseConnectionString(buildConnectionString(options, true))).toEqual(options);
        const minimal = { ...base, server: "::1", user: "o'brien", password: "" };
        expect(parseConnectionString(buildConnectionString(minimal, true))).toEqual({
            ...base,
            server: "::1",
            user: "o'brien",
        });
    });
});

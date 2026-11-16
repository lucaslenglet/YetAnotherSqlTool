import { describe, expect, it } from "vitest";
import {
    environmentReferenceFields,
    hasEnvironmentReferences,
    redactConnectionErrors,
    redactError,
    referencedVariables,
    resolveConnectionOptions,
    resolveEnvironmentReferences,
} from "../../src/connections/environmentReferences";
import type { DriverConnection } from "../../src/drivers/types";

const env = { SQL_PASSWORD: "pa$$w0rd", DB_HOST: "db.internal", EMPTY: "", USER_A: "alice" };

describe("referencedVariables", () => {
    it("lists every reference of a field, in order", () => {
        expect(referencedVariables("${env:DB_HOST}:${env:PORT_1}/${env:_x}")).toEqual([
            "DB_HOST",
            "PORT_1",
            "_x",
        ]);
    });

    it("ignores escaped references, text that is not a reference and non-strings", () => {
        for (const text of [
            "$${env:SQL_PASSWORD}",
            "${foo}",
            "$",
            "${env:}",
            "${env:1ABC}",
            "${env:A-B}",
            "${env: A}",
            "${ENV:A}",
            "{env:A}",
            "$env:A",
            "${env:A",
            "p@$$w{rd}",
        ]) {
            expect(referencedVariables(text), text).toEqual([]);
            expect(hasEnvironmentReferences(text), text).toBe(false);
        }
        expect(referencedVariables(1433)).toEqual([]);
        expect(referencedVariables(undefined)).toEqual([]);
    });
});

describe("resolveEnvironmentReferences", () => {
    it("replaces a reference with the variable's value, taken literally", () => {
        expect(resolveEnvironmentReferences("${env:SQL_PASSWORD}", env)).toBe("pa$$w0rd");
    });

    it("resolves several references and keeps the text around them", () => {
        expect(resolveEnvironmentReferences("x-${env:USER_A}${env:DB_HOST}-y", env)).toBe(
            "x-alicedb.internal-y",
        );
    });

    it("turns the escape into the literal text, without reading the variable", () => {
        expect(resolveEnvironmentReferences("$${env:NOT_SET}", env)).toBe("${env:NOT_SET}");
        expect(resolveEnvironmentReferences("a$${env:USER_A}${env:USER_A}", env)).toBe(
            "a${env:USER_A}alice",
        );
        expect(resolveEnvironmentReferences("$$${env:USER_A}", env)).toBe("$${env:USER_A}");
    });

    it("leaves malformed text and other dollar signs untouched", () => {
        for (const text of ["${foo}", "$", "${env:}", "p@$$w{rd}", "${env:A-B}", "$$"]) {
            expect(resolveEnvironmentReferences(text, env)).toBe(text);
        }
    });

    it("fails naming an unset variable, and accepts an empty one", () => {
        expect(() => resolveEnvironmentReferences("${env:SQL_PASSWORD2}", env)).toThrow(
            "Environment variable SQL_PASSWORD2 is not set",
        );
        expect(resolveEnvironmentReferences("<${env:EMPTY}>", env)).toBe("<>");
    });

    it("matches names exactly", () => {
        expect(() => resolveEnvironmentReferences("${env:sql_password}", env)).toThrow(
            "Environment variable sql_password is not set",
        );
    });

    it("reads the extension host's environment by default", () => {
        process.env.YAST_TEST_ENV_REFERENCE = "from-process";
        try {
            expect(resolveEnvironmentReferences("${env:YAST_TEST_ENV_REFERENCE}")).toBe(
                "from-process",
            );
        } finally {
            delete process.env.YAST_TEST_ENV_REFERENCE;
        }
    });
});

describe("resolveConnectionOptions", () => {
    it("resolves every string option and leaves the others", () => {
        const options = {
            server: "${env:DB_HOST}",
            user: "${env:USER_A}",
            password: "${env:SQL_PASSWORD}",
            database: "$${env:LITERAL}",
            port: 5432,
            trustServerCertificate: true,
        };
        expect(environmentReferenceFields(options).map(([key]) => key)).toEqual([
            "server",
            "user",
            "password",
        ]);
        const { options: resolved } = resolveConnectionOptions(options, env);
        expect(resolved).toEqual({
            server: "db.internal",
            user: "alice",
            password: "pa$$w0rd",
            database: "${env:LITERAL}",
            port: 5432,
            trustServerCertificate: true,
        });
        expect(options.password).toBe("${env:SQL_PASSWORD}");
    });

    it("reads nothing and redacts nothing without a reference", () => {
        const result = resolveConnectionOptions({ password: "$${env:X}", server: "h" }, {});
        expect(result.options).toEqual({ password: "${env:X}", server: "h" });
        expect(result.redact).toBeUndefined();
    });

    it("puts the typed text back in place of the values in a message", () => {
        const { redact } = resolveConnectionOptions(
            { server: "srv-${env:DB_HOST}", user: "${env:USER_A}", password: "${env:EMPTY}" },
            env,
        );
        expect(redact!("Cannot connect to srv-db.internal as 'alice' (db.internal)")).toBe(
            "Cannot connect to srv-${env:DB_HOST} as '${env:USER_A}' (${env:DB_HOST})",
        );
        // A value containing regular expression characters is matched literally.
        const secret = resolveConnectionOptions({ password: "${env:SQL_PASSWORD}" }, env);
        expect(secret.redact!("echo pa$$w0rd and paSSw0rd")).toBe(
            "echo ${env:SQL_PASSWORD} and paSSw0rd",
        );
    });

    it("replaces a short value only as a whole word", () => {
        const { redact } = resolveConnectionOptions({ user: "${env:SHORT}" }, { SHORT: "sa" });
        expect(redact!("Login failed for user 'sa'. See the message.")).toBe(
            "Login failed for user '${env:SHORT}'. See the message.",
        );
    });

    it("redacts the causes and inner errors of an error", () => {
        const { redact } = resolveConnectionOptions({ server: "${env:DB_HOST}" }, env);
        const error = new Error("outer db.internal", {
            cause: new AggregateError([new Error("inner db.internal")], "agg db.internal"),
        });

        redactError(error, redact!);

        expect(error.message).toBe("outer ${env:DB_HOST}");
        const cause = error.cause as AggregateError;
        expect(cause.message).toBe("agg ${env:DB_HOST}");
        expect((cause.errors[0] as Error).message).toBe("inner ${env:DB_HOST}");
    });
});

describe("redactConnectionErrors", () => {
    it("redacts the errors of every method and keeps everything else", async () => {
        const redact = (text: string) => text.replaceAll("alice", "${env:USER_A}");
        const inner = {
            serverInfo: { userName: "alice" },
            getCurrentDatabase: async () => "db",
            listDatabases: async () => {
                throw new Error("permission denied for alice");
            },
            close() {
                throw new Error("cannot close alice");
            },
        } as unknown as DriverConnection;
        const connection = redactConnectionErrors(inner, redact);

        expect(connection.serverInfo.userName).toBe("alice");
        expect(await connection.getCurrentDatabase()).toBe("db");
        await expect(connection.listDatabases()).rejects.toThrow(
            "permission denied for ${env:USER_A}",
        );
        expect(() => connection.close()).toThrow("cannot close ${env:USER_A}");
    });
});

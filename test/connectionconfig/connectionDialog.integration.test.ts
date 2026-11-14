import { describe, expect, it } from "vitest";
import { ApiStatus } from "../../src/sharedInterfaces/webview";
import { mssqlOptions, mssqlPort, mssqlServer, pgOptions } from "../support/databases";
import { setupDialog } from "./dialogHarness";

const h = setupDialog();
const { openDialog, state, dispatch, setField, waitFor } = h;
const pg = pgOptions();

async function fillPostgres() {
    await setField("provider", "pg");
    await setField("server", pg.server);
    await setField("port", pg.port);
    await setField("user", pg.user);
    await setField("password", pg.password);
}

describe("form", () => {
    it("lists the server's databases once the login is filled in", async () => {
        await openDialog();
        await fillPostgres();
        await waitFor(
            () => (state().formComponents.database.options?.length ?? 0) > 0,
            "database list",
        );
        const databases = state().formComponents.database.options;
        expect(databases.find((o) => o.value === "yast")?.groupName).toBe("User databases");
        expect(databases.find((o) => o.value === "postgres")?.groupName).toBe("System databases");
    });
});

describe("submit", () => {
    it("connects, saves the password in SecretStorage only, and reveals the connection", async () => {
        await openDialog();
        await fillPostgres();
        await setField("database", "yast");
        await setField("savePassword", true);
        await setField("profileName", "Local PG");
        await dispatch("connect");

        expect(state().formMessage).toBeUndefined();
        expect(h.config.connections).toHaveLength(1);
        const saved = h.config.connections[0];
        expect(saved).toMatchObject({
            provider: "pg",
            server: pg.server,
            port: pg.port,
            password: "",
        });
        expect(await h.store.lookupPassword(saved)).toBe(pg.password);
        expect(h.host.revealed.map((p) => p.profileName)).toEqual(["Local PG"]);
        expect(h.store.getRecentlyUsedConnections()).toHaveLength(0); // the tree records it when it connects
    });

    it("reports a failed login without saving", async () => {
        await openDialog();
        await fillPostgres();
        await setField("password", "wrong");
        await dispatch("connect");

        expect(state().connectionStatus).toBe(ApiStatus.Error);
        expect(state().formMessage?.message).toMatch(/password/i);
        expect(h.config.connections).toHaveLength(0);
    });

    it("asks to trust a self-signed SQL Server certificate, then connects", async () => {
        const mssql = mssqlOptions();
        await openDialog();
        await setField("server", "localhost");
        await setField("port", mssqlPort());
        await setField("user", mssql.user);
        await setField("password", mssql.password);
        await dispatch("connect");

        expect(state().dialog?.type).toBe("trustServerCert");
        expect(h.config.connections).toHaveLength(0);

        await setField("trustServerCertificate", true);
        await dispatch("closeDialog");
        await dispatch("retryLastSubmitAction");

        expect(state().formMessage).toBeUndefined();
        // Saved like vscode-mssql: the port folded into the server
        expect(h.config.connections[0]).toMatchObject({ server: mssqlServer(), provider: "mssql" });
        expect(h.config.connections[0].port).toBeUndefined();
    });

    it("tests a connection without saving it", async () => {
        await openDialog();
        await fillPostgres();
        await dispatch("testConnection");

        expect(state().testConnectionSucceeded).toBe(true);
        expect(h.config.connections).toHaveLength(0);
    });
});

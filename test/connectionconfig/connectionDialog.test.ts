import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConnectionConfig } from "../../src/connectionconfig/connectionconfig";
import { IConnectionProfile } from "../../src/models/interfaces";
import { FakeTdsServer } from "../support/fakeTdsServer";
import { setupDialog } from "./dialogHarness";

const h = setupDialog();
const { openDialog, state, dispatch, setField } = h;

describe("form", () => {
    it("opens on SQL Server with Microsoft's main options, preceded by the engine choice", async () => {
        await openDialog();
        expect(state().connectionProfile.provider).toBe("mssql");
        expect(state().connectionComponents.mainOptions.slice(0, 4)).toEqual([
            "provider",
            "server",
            "port",
            "trustServerCertificate",
        ]);
        expect(state().formComponents.provider.options.map((o) => o.value)).toEqual([
            "mssql",
            "pg",
        ]);
        expect(state().formComponents.port.placeholder).toBe("1433");
    });

    it("rebuilds the form from the PostgreSQL driver when the engine changes", async () => {
        await openDialog();
        await setField("server", "myhost");
        await setField("provider", "pg");

        expect(state().connectionProfile.server).toBe("myhost");
        expect(state().connectionComponents.mainOptions).toContain("sslmode");
        expect(state().connectionComponents.mainOptions).not.toContain("trustServerCertificate");
        expect(state().formComponents.port.placeholder).toBe("5432");
        expect(state().connectionProfile.sslmode).toBe("prefer");
    });

    it("only lists advanced option groups that have options", async () => {
        await openDialog();
        for (const provider of ["mssql", "pg"]) {
            await setField("provider", provider);
            const groups = state().connectionComponents.groupedAdvancedOptions;
            expect(groups.length).toBeGreaterThan(0);
            for (const group of groups) {
                expect(group?.options.length, `${provider} group`).toBeGreaterThan(0);
            }
        }
    });
});

describe("saved connections", () => {
    it("loads a SQL Server profile for edit with its port in its own box and its saved password", async () => {
        const profile = {
            id: "p1",
            provider: "mssql",
            server: "localhost,11433",
            user: "sa",
            authenticationType: "SqlLogin",
            savePassword: true,
            groupId: ConnectionConfig.ROOT_GROUP_ID,
        } as IConnectionProfile;
        h.config.connections.push(profile);
        await h.secrets.store("yast:profile:p1", "secret");

        await openDialog(profile);

        expect(state().isEditingConnection).toBe(true);
        expect(state().connectionProfile).toMatchObject({
            server: "localhost",
            port: 11433,
            password: "secret",
        });
        expect(state().savedConnections).toHaveLength(1);
    });

    it("deletes a saved connection and its password after confirmation", async () => {
        const profile = { id: "p1", server: "x", savePassword: true } as IConnectionProfile;
        h.config.connections.push(profile);
        await h.secrets.store("yast:profile:p1", "secret");
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce("Delete" as never);

        await openDialog();
        await dispatch("deleteSavedConnection", { connection: profile });

        expect(h.config.connections).toHaveLength(0);
        expect(h.secrets.values.size).toBe(0);
        expect(state().savedConnections).toHaveLength(0);
    });
});

describe("connection string", () => {
    it("fills the form from a PostgreSQL URI, switching the engine", async () => {
        await openDialog();
        await dispatch("loadFromConnectionString", {
            connectionString: "postgresql://yast:yast@localhost:15432/yast?sslmode=disable",
        });

        expect(state().connectionProfile).toMatchObject({
            provider: "pg",
            server: "localhost",
            port: 15432,
            user: "yast",
            password: "yast",
            database: "yast",
            sslmode: "disable",
        });
        expect(state().connectionComponents.mainOptions).toContain("sslmode");
    });

    it("shows the current SQL Server form as a connection string", async () => {
        await openDialog();
        await setField("server", "myhost");
        await setField("port", 1444);
        await setField("user", "sa");
        await setField("password", "pw");
        await dispatch("openConnectionStringDialog");

        expect(state().dialog?.type).toBe("loadFromConnectionString");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (state().dialog as any).connectionString as string;
        expect(text).toContain("Data Source=myhost,1444");
        expect(text).toContain("User ID=sa");
        expect(text).toContain("Password=pw");
    });
});

describe("database filter", () => {
    const saved = (filter?: string) =>
        ({
            id: "p1",
            provider: "mssql",
            server: "localhost,11433",
            user: "sa",
            authenticationType: "SqlLogin",
            savePassword: true,
            groupId: ConnectionConfig.ROOT_GROUP_ID,
            ...(filter === undefined ? {} : { databaseFilter: filter }),
        }) as IConnectionProfile;

    async function fillLogin() {
        await openDialog();
        await setField("server", "myhost");
        await setField("user", "sa");
        await setField("password", "pw");
    }

    it("is a plain optional text field, not an advanced option, on both engines", async () => {
        await openDialog();
        for (const provider of ["mssql", "pg"]) {
            await setField("provider", provider);
            expect(state().formComponents.databaseFilter).toMatchObject({
                propertyName: "databaseFilter",
                type: "input",
                required: false,
                isAdvancedOption: false,
                placeholder: "*-dev-*",
            });
            expect(state().formComponents.databaseFilter.tooltip).toContain("'!'");
            expect(state().connectionComponents.mainOptions).not.toContain("databaseFilter");
        }
    });

    it("is saved in the profile", async () => {
        await fillLogin();
        await setField("databaseFilter", "*-dev-*;!*-old");
        await dispatch("saveWithoutConnecting");

        expect(h.config.connections).toHaveLength(1);
        expect(h.config.connections[0].databaseFilter).toBe("*-dev-*;!*-old");
    });

    it("is not written when empty", async () => {
        await fillLogin();
        await setField("databaseFilter", "");
        await dispatch("saveWithoutConnecting");

        expect(h.config.connections).toHaveLength(1);
        expect("databaseFilter" in h.config.connections[0]).toBe(false);
    });

    it("shows when the connection is edited, and leaves the profile once cleared", async () => {
        const profile = saved("*-rec-*");
        h.config.connections.push(profile);
        await openDialog(profile);
        expect(state().connectionProfile.databaseFilter).toBe("*-rec-*");

        await setField("databaseFilter", "");
        await dispatch("saveWithoutConnecting");

        expect(h.config.connections).toHaveLength(1);
        expect("databaseFilter" in h.config.connections[0]).toBe(false);
    });

    it("is kept when a connection is copied as a new draft", async () => {
        const profile = saved("*-dev-*");
        h.config.connections.push(profile);
        await openDialog();
        await dispatch("loadConnectionAsNewDraft", { connection: profile });

        expect(state().isEditingConnection).toBe(false);
        expect(state().connectionProfile.id).toBeUndefined();
        expect(state().connectionProfile.databaseFilter).toBe("*-dev-*");
    });

    it("is kept when the engine changes, and when a connection string is loaded", async () => {
        await openDialog();
        await setField("databaseFilter", "app_*");
        await setField("provider", "pg");
        expect(state().connectionProfile.databaseFilter).toBe("app_*");
        await setField("provider", "mssql");
        expect(state().connectionProfile.databaseFilter).toBe("app_*");

        await dispatch("loadFromConnectionString", {
            connectionString: "postgresql://yast:yast@localhost:15432/yast",
        });
        expect(state().connectionProfile.provider).toBe("pg");
        expect(state().connectionProfile.databaseFilter).toBe("app_*");
    });
});

describe("Windows Authentication", () => {
    const hidden = (name: string) => state().formComponents[name].hidden;

    it("is offered for SQL Server, with the user and password fields, and a DOMAIN\\user hint", async () => {
        await openDialog();
        const offered = state().formComponents.authenticationType.options;
        expect(offered.find((o) => o.value === "Integrated")?.displayName).toBe(
            "Windows Authentication",
        );

        await setField("authenticationType", "Integrated");

        expect(hidden("user")).toBe(false);
        expect(hidden("password")).toBe(false);
        expect(hidden("savePassword")).toBe(false);
        expect(state().formComponents.user.required).toBe(true);
        expect(state().formComponents.user.placeholder).toBe("DOMAIN\\user");
        expect(state().formComponents.user.tooltip).toMatch(/DOMAIN\\user/);

        // A user name is required before connecting.
        await setField("server", "myhost");
        await setField("password", "pw");
        await setField("user", "");
        expect(state().readyToConnect).toBe(false);
        await setField("user", "CORP\\alice");
        expect(state().readyToConnect).toBe(true);

        // Back to SQL Login: the hint goes away.
        await setField("authenticationType", "SqlLogin");
        expect(state().formComponents.user.placeholder).toBeUndefined();
    });

    it("is not offered for PostgreSQL", async () => {
        await openDialog();
        await setField("provider", "pg");
        const offered = state().formComponents.authenticationType?.options ?? [];
        expect(offered.map((o) => o.value)).not.toContain("Integrated");
    });

    describe("against a SQL Server stand-in", () => {
        let server: FakeTdsServer;
        beforeEach(async () => {
            server = await new FakeTdsServer().start();
            server.windowsLogins.set("CORP\\alice", "s3cret");
        });
        afterEach(() => server.stop());

        async function fill(user: string, password: string) {
            await openDialog();
            await setField("server", "127.0.0.1");
            await setField("port", server.port);
            await setField("trustServerCertificate", true);
            await setField("authenticationType", "Integrated");
            await setField("user", user);
            await setField("password", password);
        }

        it("saves a profile with authenticationType Integrated and the password in SecretStorage", async () => {
            await fill("CORP\\alice", "s3cret");
            await setField("savePassword", true);
            await dispatch("connect");

            expect(state().formMessage).toBeUndefined();
            expect(h.config.connections).toHaveLength(1);
            const saved = h.config.connections[0];
            expect(saved).toMatchObject({
                authenticationType: "Integrated",
                user: "CORP\\alice",
                password: "",
                savePassword: true,
            });
            expect(await h.store.lookupPassword(saved)).toBe("s3cret");
            expect(server.logins.at(-1)?.ntlm?.proofValid).toBe(true);
        });

        it("reports a refused sign-in and saves nothing", async () => {
            await fill("CORP\\alice", "wrong");
            await dispatch("connect");

            expect(state().formMessage?.message).toMatch(/Login failed for user 'CORP\\alice'/);
            expect(h.config.connections).toHaveLength(0);
        });

        it("explains a user name without a domain before any network access", async () => {
            await fill("alice", "s3cret");
            await dispatch("connect");

            expect(state().formMessage?.message).toMatch(/expects the domain and the user name/);
            expect(server.logins).toHaveLength(0);
        });
    });
});

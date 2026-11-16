import { describe, expect, it } from "vitest";
import { sqlToolsConnectionProvider } from "../../src/drivers/mssql/connectionOptions.generated";
import {
    IMPORTED_PROFILE_KEYS,
    analyzeMssqlSettings,
    buildImportPlan,
    formatReport,
    summarize,
    type ExistingState,
    type ImportCandidate,
    type MssqlAnalysis,
} from "../../src/connections/mssqlImport";

const empty: ExistingState = { profiles: [], groups: [], rootGroupId: "ROOT" };

function ids() {
    let n = 0;
    return () => `new-${++n}`;
}

function analyze(connections: unknown, groups: unknown = [], existing = empty): MssqlAnalysis {
    return analyzeMssqlSettings(connections, groups, existing);
}

function sql(overrides: Record<string, unknown> = {}) {
    return {
        id: "c1",
        server: "srv",
        database: "db",
        user: "alice",
        authenticationType: "SqlLogin",
        savePassword: false,
        password: "",
        ...overrides,
    };
}

function only(analysis: MssqlAnalysis): ImportCandidate {
    expect(analysis.refused).toEqual([]);
    expect(analysis.candidates).toHaveLength(1);
    return analysis.candidates[0];
}

function all(analysis: MssqlAnalysis): Set<number> {
    return new Set(analysis.candidates.map((c) => c.key));
}

describe("keys carried over", () => {
    it("are known option names of the SQL Server driver", () => {
        const known = new Set(sqlToolsConnectionProvider.options.map((o) => o.name));
        const profileOnly = new Set([
            "email",
            "accountId",
            "tenantId",
            "profileName",
            "savePassword",
            "emptyPasswordInput",
            "order",
        ]);
        for (const key of Object.keys(IMPORTED_PROFILE_KEYS)) {
            expect(known.has(key) || profileOnly.has(key), key).toBe(true);
        }
    });
});

describe("profiles", () => {
    it("maps a SQL login one to one and asks for its password later", () => {
        const c = only(
            analyze([
                sql({
                    profileName: "Prod",
                    port: 1434,
                    encrypt: "Strict",
                    trustServerCertificate: true,
                    applicationIntent: "ReadOnly",
                    savePassword: true,
                    order: 2,
                }),
            ]),
        );
        expect(c.profile).toEqual({
            id: "c1",
            server: "srv",
            database: "db",
            user: "alice",
            authenticationType: "SqlLogin",
            profileName: "Prod",
            port: 1434,
            encrypt: "Strict",
            trustServerCertificate: true,
            applicationIntent: "ReadOnly",
            savePassword: true,
            order: 2,
        });
        expect(c.label).toBe("Prod");
        expect(c.unsupportedKeys).toEqual([]);
        expect(c.warnings).toEqual([]);
        expect(c.actions).toEqual(["the password is asked at the first connection, then saved."]);
    });

    it("labels a profile without a name as vscode-mssql does", () => {
        expect(only(analyze([sql()])).label).toBe("srv, db (alice)");
        expect(only(analyze([sql({ database: "" })])).label).toBe("srv, <default> (alice)");
    });

    it("treats a missing authentication type as a SQL login", () => {
        const c = only(analyze([sql({ authenticationType: undefined })]));
        expect(c.profile.authenticationType).toBe("SqlLogin");
    });

    it("does not ask for a password when it is empty by design", () => {
        const c = only(analyze([sql({ emptyPasswordInput: true })]));
        expect(c.actions).toEqual([]);
    });

    it("keeps a password written in settings only when Save Password is on", () => {
        const kept = only(analyze([sql({ password: "hunter2", savePassword: true })]));
        expect(kept.profile.password).toBe("hunter2");
        expect(kept.actions).toEqual([]);

        const dropped = only(analyze([sql({ password: "hunter2", savePassword: false })]));
        expect(dropped.profile.password).toBeUndefined();
        expect(dropped.warnings.join()).toContain("Save Password");
        expect(dropped.actions).toHaveLength(1);
    });

    it("never puts a password in a message or the report", () => {
        const a = analyze([sql({ password: "hunter2", azureAccountToken: "tok3n" })]);
        const plan = buildImportPlan(a, all(a), empty, ids());
        const text = [
            ...a.notes,
            ...a.candidates.flatMap((c) => [...c.warnings, ...c.actions, ...c.unsupportedKeys]),
            ...formatReport(a, { plan, failed: [] }),
        ].join("\n");
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("tok3n");
    });

    it("leaves out the keys the driver does not use, by name, and ignores empty ones", () => {
        const c = only(
            analyze([
                sql({
                    pooling: true,
                    maxPoolSize: 20,
                    columnEncryptionSetting: "Enabled",
                    containerName: "c",
                    azureAccountToken: "",
                    expiresOn: null,
                    somethingNew: 1,
                }),
            ]),
        );
        expect(c.unsupportedKeys.sort()).toEqual([
            "columnEncryptionSetting",
            "containerName",
            "maxPoolSize",
            "pooling",
            "somethingNew",
        ]);
        expect(c.profile).not.toHaveProperty("pooling");
        expect(c.profile).not.toHaveProperty("azureAccountToken");
    });

    it("does not report what vscode-mssql writes on every profile", () => {
        const c = only(analyze([sql({ applicationName: "vscode-mssql", azureAuthType: 0 })]));
        expect(c.profile).not.toHaveProperty("applicationName");
        expect(c.unsupportedKeys).toEqual([]);
        const own = only(analyze([sql({ applicationName: "my app" })]));
        expect(own.profile.applicationName).toBe("my app");
    });

    it("does not import a connection string, and says so", () => {
        const c = only(analyze([sql({ connectionString: "Server=x;Password=hunter2" })]));
        expect(c.profile).not.toHaveProperty("connectionString");
        expect(c.warnings).toEqual(["its connection string is not imported."]);
        expect(JSON.stringify(c)).not.toContain("hunter2");
    });

    it("refuses a profile defined by a connection string only", () => {
        const a = analyze([{ id: "x", profileName: "Legacy", connectionString: "Server=x" }]);
        expect(a.candidates).toEqual([]);
        expect(a.refused).toEqual([
            {
                label: "Legacy",
                reason: "it is defined by a connection string only, which YAST does not import.",
            },
        ]);
    });

    it("leaves out a value of the wrong type with a warning, and keeps the rest", () => {
        const c = only(
            analyze([
                sql({
                    port: "abc",
                    trustServerCertificate: "yes",
                    encrypt: 3,
                    applicationIntent: "Sideways",
                    connectTimeout: {},
                    packetSize: "4096",
                }),
            ]),
        );
        expect(c.warnings).toHaveLength(5);
        expect(c.profile.packetSize).toBe(4096);
        expect(c.profile).not.toHaveProperty("port");
        expect(c.profile.user).toBe("alice");
    });

    it("accepts a boolean or a known string for encrypt", () => {
        expect(only(analyze([sql({ encrypt: false })])).profile.encrypt).toBe(false);
        expect(only(analyze([sql({ encrypt: "Optional" })])).profile.encrypt).toBe("Optional");
    });
});

describe("authentication types", () => {
    it("keeps the Entra ID account of the VS Code Microsoft provider", () => {
        const c = only(
            analyze([
                sql({
                    authenticationType: "AzureMFA",
                    user: "a@b.c",
                    email: "a@b.c",
                    accountId: "0000.1111",
                    tenantId: "1111",
                }),
            ]),
        );
        expect(c.profile).toMatchObject({
            authenticationType: "AzureMFA",
            accountId: "0000.1111",
            tenantId: "1111",
            email: "a@b.c",
        });
        expect(c.actions).toEqual([]);
        expect(c.label).toBe("srv, db (a@b.c)");
    });

    it("drops an account id of an unknown form and asks to choose the account again", () => {
        const c = only(analyze([sql({ authenticationType: "AzureMFA", accountId: "weird id" })]));
        expect(c.profile).not.toHaveProperty("accountId");
        expect(c.warnings).toHaveLength(1);
        expect(c.actions).toEqual(["the Microsoft account is chosen at the first connection."]);
    });

    it("asks to choose the account when the profile has none", () => {
        const c = only(analyze([sql({ authenticationType: "AzureMFA" })]));
        expect(c.actions).toHaveLength(1);
        expect(c.warnings).toEqual([]);
    });

    it("explains that Windows Authentication needs an account and a password", () => {
        const c = only(analyze([sql({ authenticationType: "Integrated", user: "" })]));
        expect(c.profile.authenticationType).toBe("Integrated");
        expect(c.actions).toHaveLength(1);
        expect(c.actions[0]).toContain("DOMAIN\\user");
    });

    it("imports a service principal and asks for its secret", () => {
        const c = only(
            analyze([
                sql({
                    authenticationType: "ActiveDirectoryServicePrincipal",
                    tenantId: "t",
                    savePassword: true,
                }),
            ]),
        );
        expect(c.actions).toEqual([
            "the client secret is asked at the first connection, then saved.",
        ]);
        expect(c.profile.tenantId).toBe("t");
    });

    it("imports ActiveDirectoryDefault with nothing to complete", () => {
        const c = only(analyze([sql({ authenticationType: "ActiveDirectoryDefault", user: "" })]));
        expect(c.actions).toEqual([]);
    });

    it("refuses the authentication types YAST does not handle", () => {
        const a = analyze([
            sql({ authenticationType: "ActiveDirectoryPassword" }),
            sql({ id: "c2", authenticationType: 5 }),
        ]);
        expect(a.candidates).toEqual([]);
        expect(a.refused.map((r) => r.reason)).toEqual([
            'the authentication type "ActiveDirectoryPassword" is not supported by YAST.',
            "its authentication type is not text.",
        ]);
    });
});

describe("malformed entries", () => {
    it("never throw, and refuse or warn instead", () => {
        const a = analyze([
            null,
            42,
            "text",
            [],
            {},
            { server: 5 },
            { server: "  " },
            sql({ id: "ok" }),
            sql({ id: "ok2", groupId: 12 }),
        ]);
        expect(a.candidates.map((c) => c.profile.id)).toEqual(["ok", "ok2"]);
        expect(a.refused).toHaveLength(7);
        expect(a.refused[0]).toEqual({
            label: "Connection #1 of mssql.connections",
            reason: "it is not an object.",
        });
        expect(a.candidates[1].warnings).toEqual(["its group is not valid: placed at the root."]);
    });

    it("handle settings that are not lists", () => {
        const a = analyze("nope", { not: "a list" });
        expect(a.candidates).toEqual([]);
        expect(a.notes).toEqual([
            "mssql.connectionGroups is not a list: groups were not imported.",
            "mssql.connections is not a list: nothing to import.",
        ]);
        expect(analyze(undefined, undefined).notes).toEqual([]);
    });

    it("ignore broken groups with a note, and keep the good ones", () => {
        const a = analyze(
            [sql({ groupId: "g" })],
            [
                null,
                "x",
                { id: "g" },
                { name: "n" },
                { id: "g", name: "Good" },
                { id: "g", name: "Twin" },
            ],
        );
        expect(a.notes).toHaveLength(5);
        expect(only(a).groupPath).toEqual(["Good"]);
    });

    it("leave out a group color that is not #RRGGBB, since it ends up in an SVG", () => {
        const a = analyze(
            [sql({ groupId: "g" })],
            [{ id: "g", name: "G", color: '"/><script>', description: 3, order: "x" }],
        );
        const plan = buildImportPlan(a, all(a), empty, ids());
        expect(plan.groupsToAdd).toEqual([{ id: "g", name: "G", parentId: "ROOT" }]);
        expect(plan.groupWarnings).toHaveLength(3);
    });
});

describe("groups", () => {
    const groups = [
        { id: "ROOT", name: "ROOT" },
        {
            id: "a",
            name: "Prod",
            parentId: "ROOT",
            color: "#FF0000",
            description: "Live",
            order: 1,
        },
        { id: "b", name: "EU", parentId: "a" },
        { id: "c", name: "Paris", parentId: "b" },
        { id: "d", name: "Dev" },
    ];

    it("keeps the tree several levels deep, creating only the groups the profiles need", () => {
        const a = analyze([sql({ groupId: "c" })], groups);
        const plan = buildImportPlan(a, all(a), empty, ids());
        expect(plan.groupsToAdd).toEqual([
            {
                id: "a",
                name: "Prod",
                parentId: "ROOT",
                color: "#ff0000",
                description: "Live",
                order: 1,
            },
            { id: "b", name: "EU", parentId: "a" },
            { id: "c", name: "Paris", parentId: "b" },
        ]);
        expect(plan.profilesToAdd[0].groupId).toBe("c");
        expect(a.candidates[0].groupPath).toEqual(["Prod", "EU", "Paris"]);
    });

    it("does not create the groups of profiles that are not selected", () => {
        const a = analyze([sql({ groupId: "c" }), sql({ id: "c2", groupId: "d" })], groups);
        const plan = buildImportPlan(a, new Set([1]), empty, ids());
        expect(plan.groupsToAdd.map((g) => g.name)).toEqual(["Dev"]);
        expect(plan.skipped).toHaveLength(1);
    });

    it("maps the root to YAST's root, never creating a second one, also for a legacy root", () => {
        const legacy = [
            { id: "uuid-root", name: "ROOT" },
            { id: "x", name: "X", parentId: "uuid-root" },
        ];
        const a = analyze([sql({ groupId: "uuid-root" }), sql({ id: "c2", groupId: "x" })], legacy);
        const plan = buildImportPlan(a, all(a), { ...empty, rootGroupId: "ROOT" }, ids());
        expect(plan.groupsToAdd).toEqual([{ id: "x", name: "X", parentId: "ROOT" }]);
        expect(plan.profilesToAdd.map((p) => p.groupId)).toEqual(["ROOT", "x"]);
    });

    it("places a profile whose group is missing at the root, with a warning", () => {
        const a = analyze([sql({ groupId: "gone" })], groups);
        expect(only(a).warnings).toEqual([
            "its group does not exist in mssql.connectionGroups: placed at the root.",
        ]);
        const plan = buildImportPlan(a, all(a), empty, ids());
        expect(plan.profilesToAdd[0].groupId).toBe("ROOT");
        expect(plan.groupsToAdd).toEqual([]);
    });

    it("attaches a group with a missing parent, or in a loop, to the root", () => {
        const a = analyze(
            [sql({ groupId: "o" }), sql({ id: "c2", groupId: "l1" })],
            [
                { id: "o", name: "Orphan", parentId: "nowhere" },
                { id: "l1", name: "L1", parentId: "l2" },
                { id: "l2", name: "L2", parentId: "l1" },
            ],
        );
        expect(a.notes).toEqual([
            'The parent of connection group "Orphan" is missing or loops: the group is placed at the root.',
            'The parent of connection group "L2" is missing or loops: the group is placed at the root.',
        ]);
        const plan = buildImportPlan(a, all(a), empty, ids());
        expect(plan.groupsToAdd.every((g) => g.parentId === "ROOT" || g.parentId === "l2")).toBe(
            true,
        );
        expect(plan.profilesToAdd.every((p) => typeof p.groupId === "string")).toBe(true);
    });

    it("reuses the groups of a first import by id, and by name under the same parent", () => {
        const a = analyze([sql({ groupId: "c" }), sql({ id: "c2", groupId: "d" })], groups);
        const state: ExistingState = {
            profiles: [],
            groups: [
                { id: "ROOT", name: "ROOT", inUserSettings: true },
                { id: "a", name: "Prod", parentId: "ROOT", inUserSettings: true },
                // made by hand: another id, same name under the same parent
                { id: "hand", name: "EU", parentId: "a", inUserSettings: true },
                { id: "dev-by-hand", name: "Dev", parentId: "ROOT", inUserSettings: true },
            ],
            rootGroupId: "ROOT",
        };
        const plan = buildImportPlan(a, all(a), state, ids());
        expect(plan.groupsToAdd).toEqual([{ id: "c", name: "Paris", parentId: "hand" }]);
        expect(plan.groupsReused).toBe(3);
        expect(plan.profilesToAdd.map((p) => p.groupId)).toEqual(["c", "dev-by-hand"]);
    });

    it("does not reuse a workspace group, and avoids its id", () => {
        const a = analyze([sql({ groupId: "d" })], groups);
        const state: ExistingState = {
            profiles: [],
            groups: [{ id: "d", name: "Dev", parentId: "ROOT", inUserSettings: false }],
            rootGroupId: "ROOT",
        };
        const plan = buildImportPlan(a, all(a), state, ids());
        expect(plan.groupsToAdd).toEqual([{ id: "new-1", name: "Dev", parentId: "ROOT" }]);
        expect(plan.profilesToAdd[0].groupId).toBe("new-1");
    });

    it("creates a group shared by two profiles once", () => {
        const a = analyze([sql({ groupId: "a" }), sql({ id: "c2", groupId: "a" })], groups);
        const plan = buildImportPlan(a, all(a), empty, ids());
        expect(plan.groupsToAdd).toHaveLength(1);
    });
});

describe("profiles already in YAST", () => {
    const present = {
        id: "other",
        server: "SRV",
        database: "db",
        user: "ALICE",
        authenticationType: "SqlLogin",
    };

    it("are marked, by server, database, user and authentication type", () => {
        const state: ExistingState = { ...empty, profiles: [present] };
        const a = analyze(
            [
                sql(),
                sql({ id: "c2", database: "other" }),
                sql({ id: "c3", user: "bob" }),
                sql({ id: "c4", authenticationType: "Integrated" }),
                sql({ id: "c5", port: 1500 }),
            ],
            [],
            state,
        );
        expect(a.candidates.map((c) => c.alreadyPresent)).toEqual([
            "already in YAST",
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });

    it("tell two Entra ID accounts apart, and take an empty database for master", () => {
        const state: ExistingState = {
            ...empty,
            profiles: [
                { server: "srv", authenticationType: "AzureMFA", user: "", accountId: "a.b" },
                { server: "db-less", database: "", user: "alice" },
            ],
        };
        const a = analyze(
            [
                sql({ authenticationType: "AzureMFA", user: "", database: "", accountId: "a.b" }),
                sql({
                    id: "c2",
                    authenticationType: "AzureMFA",
                    user: "",
                    database: "",
                    accountId: "c.d",
                }),
                sql({ id: "c3", server: "db-less", database: "master" }),
            ],
            [],
            state,
        );
        expect(a.candidates.map((c) => c.alreadyPresent)).toEqual([
            "already in YAST",
            undefined,
            "already in YAST",
        ]);
    });

    it("are not compared with the profiles of another engine", () => {
        const state: ExistingState = { ...empty, profiles: [{ ...present, provider: "pg" }] };
        expect(only(analyze([sql()], [], state)).alreadyPresent).toBeUndefined();
    });

    it("are recognized by id on a second run, even when edited in YAST", () => {
        const state: ExistingState = {
            ...empty,
            profiles: [{ id: "c1", server: "renamed", user: "x", authenticationType: "SqlLogin" }],
        };
        expect(only(analyze([sql()], [], state)).alreadyPresent).toBe(
            "already in YAST (imported before)",
        );
    });

    it("mark a duplicate inside the imported list", () => {
        const a = analyze([sql({ profileName: "First" }), sql({ id: "c2" })]);
        expect(a.candidates.map((c) => c.alreadyPresent)).toEqual([undefined, 'same as "First"']);
    });

    it("never replace a profile of YAST when the user imports it anyway: the id is renewed", () => {
        const state: ExistingState = { ...empty, profiles: [{ id: "c1", server: "x" }] };
        const a = analyze([sql(), sql({ id: "c1", server: "other" })], [], state);
        const plan = buildImportPlan(a, all(a), state, ids());
        expect(plan.profilesToAdd.map((p) => p.id)).toEqual([undefined, undefined]);
    });

    it("keep the id of a new profile, so that a second import finds it", () => {
        const a = analyze([sql()]);
        expect(buildImportPlan(a, all(a), empty, ids()).profilesToAdd[0].id).toBe("c1");
    });

    it("a second run finds everything the first one added, creating nothing", () => {
        const connections = [sql({ groupId: "c" }), sql({ id: "c2", server: "s2", groupId: "a" })];
        const groups = [
            { id: "a", name: "Prod" },
            { id: "c", name: "Paris", parentId: "a" },
        ];
        const first = analyze(connections, groups);
        const plan = buildImportPlan(first, all(first), empty, ids());
        const afterFirst: ExistingState = {
            rootGroupId: "ROOT",
            profiles: plan.profilesToAdd.map((p) => ({ ...p })),
            groups: [
                { id: "ROOT", name: "ROOT", inUserSettings: true },
                ...plan.groupsToAdd.map((g) => ({ ...g, inUserSettings: true })),
            ],
        };
        const second = analyze(connections, groups, afterFirst);
        expect(second.candidates.every((c) => c.alreadyPresent)).toBe(true);
        const again = buildImportPlan(second, all(second), afterFirst, ids());
        expect(again.groupsToAdd).toEqual([]);
    });
});

describe("report", () => {
    it("lists, per profile, what was left out, refused and to do, and counts them", () => {
        const a = analyze(
            [
                sql({ profileName: "Prod", groupId: "g", pooling: true }),
                sql({ id: "c2", profileName: "Win", authenticationType: "Integrated" }),
                sql({ id: "c3", authenticationType: "Kerberos" }),
                sql({ id: "c4", profileName: "Done" }),
            ],
            [{ id: "g", name: "Prod group" }],
            { ...empty, profiles: [{ server: "srv", database: "db", user: "alice" }] },
        );
        const plan = buildImportPlan(a, new Set([0, 1]), empty, ids());
        const lines = formatReport(a, { plan, failed: [] });
        expect(lines[0]).toBe("Imported 2 connection(s), created 1 group(s), reused 0 group(s).");
        expect(lines).toContain(
            'Not imported: "srv, db (Kerberos)": the authentication type "Kerberos" is not supported by YAST.',
        );
        expect(
            lines.some((l) =>
                l.startsWith(
                    '"Prod" [Prod group]: left out, not supported by YAST: pooling; to do: the password',
                ),
            ),
        ).toBe(true);
        expect(lines.some((l) => l.startsWith('"Win": to do: Windows Authentication'))).toBe(true);
        expect(lines.some((l) => l.startsWith('Skipped: "Done"'))).toBe(true);
        expect(summarize(a, { plan, failed: [] })).toEqual({
            imported: 2,
            groupsCreated: 1,
            skipped: 1,
            refused: 1,
            withWarnings: 1,
            withActions: 2,
        });
    });

    it("does not count a profile that could not be saved as imported", () => {
        const a = analyze([sql()]);
        const plan = buildImportPlan(a, all(a), empty, ids());
        const lines = formatReport(a, { plan, failed: [0] });
        expect(lines[0]).toContain("Imported 0 connection(s)");
        expect(lines.join("\n")).toContain("it could not be saved");
        expect(summarize(a, { plan, failed: [0] }).imported).toBe(0);
    });
});

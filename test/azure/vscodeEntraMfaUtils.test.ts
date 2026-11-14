import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
    acquireTokenFromVscodeAccount,
    areCompatibleEntraAccountIds,
    getDefaultTenantId,
    getHomeTenantIdForAccount,
    getTenantsForAccount,
    getVscodeEntraAccountOptions,
    getVscodeEntraTenantOptions,
    isPersonalMicrosoftAccount,
    MissingEntraAuthAccountError,
    MSA_TENANT_ID,
} from "../../src/azure/vscodeEntraMfaUtils";

const tenant = (tenantId: string) => ({ tenantId, displayName: tenantId });

describe("VS Code Entra accounts", () => {
    it("reads the home tenant from a VS Code account id", () => {
        expect(getHomeTenantIdForAccount("oid.home-tenant")).toBe("home-tenant");
        expect(getHomeTenantIdForAccount("oid")).toBeUndefined();
    });

    it("recognizes personal Microsoft accounts", () => {
        expect(isPersonalMicrosoftAccount(`oid.${MSA_TENANT_ID}`)).toBe(true);
        expect(isPersonalMicrosoftAccount("oid.work-tenant")).toBe(false);
        expect(isPersonalMicrosoftAccount(undefined)).toBe(false);
    });

    it("prefers the home tenant, else the first one", () => {
        expect(getDefaultTenantId("oid.b", [tenant("a"), tenant("b")])).toBe("b");
        // Personal Microsoft accounts: the home tenant may not be listed.
        expect(getDefaultTenantId("oid.msa", [tenant("a"), tenant("b")])).toBe("a");
        expect(getDefaultTenantId("oid.b", [])).toBe("");
    });

    it("matches account ids saved with or without their tenant", () => {
        expect(areCompatibleEntraAccountIds("OID.tenant", "oid")).toBe(true);
        expect(areCompatibleEntraAccountIds("oid.tenant", "other")).toBe(false);
        expect(areCompatibleEntraAccountIds(undefined, "oid")).toBe(false);
    });
});

// The part played by VS Code: its Microsoft account provider is replaced (test/vscodeMock.ts),
// and so is the one HTTP call, the list of an account's tenants.

const DATABASE_SCOPE = "https://database.windows.net/.default";
const MANAGEMENT_SCOPE = "https://management.azure.com/.default";
const getSession = vi.mocked(vscode.authentication.getSession);
const getAccounts = vi.mocked(vscode.authentication.getAccounts);

/** A VS Code account: its id is "<object id>.<home tenant id>". */
const account = (objectId: string, homeTenantId: string, label = `${objectId}@contoso.com`) => ({
    id: `${objectId}.${homeTenantId}`,
    label,
});

function signedIn(...accounts: { id: string; label: string }[]): void {
    getAccounts.mockResolvedValue(accounts as never);
}

/** Gives a session with `databaseToken` for database scopes and, when there is one, `managementToken` for the tenant list. */
function sessions(databaseToken: string | undefined, managementToken?: string): void {
    getSession.mockImplementation((async (_provider: string, scopes: string[]) => {
        const token = scopes[0] === MANAGEMENT_SCOPE ? managementToken : databaseToken;
        return token === undefined ? undefined : { accessToken: token };
    }) as never);
}

/** Answer of Azure Resource Manager to the tenant list request. */
function tenantList(
    tenants: { tenantId: string; displayName?: string; defaultDomain?: string }[],
    status = 200,
) {
    const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ value: tenants }), { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

/** The calls that asked for a database token (not those of the tenant list). */
const databaseSessionCalls = () =>
    getSession.mock.calls.filter(
        ([, scopes]: unknown[]) => (scopes as string[])[0] === DATABASE_SCOPE,
    );

beforeEach(() => {
    getSession.mockReset();
    getAccounts.mockReset();
    // Any HTTP call a test did not plan fails instead of reaching Microsoft.
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("unexpected HTTP call"))),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("acquireTokenFromVscodeAccount", () => {
    it("asks VS Code for the session of the profile's account and tenant, without prompting", async () => {
        const work = account("work", "home-tenant");
        signedIn(account("other", "other-tenant"), work);
        sessions("DATABASE-TOKEN");

        const token = await acquireTokenFromVscodeAccount(
            DATABASE_SCOPE,
            work.id,
            " guest-tenant ",
        );

        expect(token).toBe("DATABASE-TOKEN");
        expect(getAccounts).toHaveBeenCalledWith("microsoft");
        expect(getSession.mock.calls).toEqual([
            [
                "microsoft",
                [DATABASE_SCOPE, "VSCODE_TENANT:guest-tenant"],
                { account: work, silent: true },
            ],
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("finds the account of a profile saved without the tenant part of its id", async () => {
        const work = account("work", "home-tenant");
        signedIn(account("other", "other-tenant"), work);
        sessions("DATABASE-TOKEN");

        await acquireTokenFromVscodeAccount(DATABASE_SCOPE, "WORK", "home-tenant");

        expect(getSession.mock.calls[0][2]).toEqual({ account: work, silent: true });
    });

    it("shows the sign-in prompt only when VS Code has no token to give silently", async () => {
        const work = account("work", "home-tenant");
        signedIn(work);
        getSession
            .mockResolvedValueOnce(undefined as never)
            .mockResolvedValueOnce({ accessToken: "AFTER-PROMPT" } as never);

        const token = await acquireTokenFromVscodeAccount(DATABASE_SCOPE, work.id, "home-tenant");

        expect(token).toBe("AFTER-PROMPT");
        const scopes = [DATABASE_SCOPE, "VSCODE_TENANT:home-tenant"];
        expect(getSession.mock.calls).toEqual([
            ["microsoft", scopes, { account: work, silent: true }],
            ["microsoft", scopes, { account: work, createIfNone: true }],
        ]);
    });

    it("fails when VS Code gives no session at all", async () => {
        const work = account("work", "home-tenant", "someone@contoso.com");
        signedIn(work);
        sessions(undefined);

        await expect(
            acquireTokenFromVscodeAccount(DATABASE_SCOPE, work.id, "home-tenant"),
        ).rejects.toThrow(
            "Unable to get a Microsoft Entra ID token from VS Code for someone@contoso.com.",
        );
    });

    it("fails without asking for a token when the profile's account is not signed in to VS Code", async () => {
        signedIn(account("other", "other-tenant"));

        const attempt = acquireTokenFromVscodeAccount(
            DATABASE_SCOPE,
            "gone.home-tenant",
            "home-tenant",
        );

        await expect(attempt).rejects.toBeInstanceOf(MissingEntraAuthAccountError);
        await expect(attempt).rejects.toThrow(
            "The Microsoft account gone.home-tenant is not signed in to VS Code.",
        );
        expect(getSession).not.toHaveBeenCalled();
    });

    it("lets VS Code pick the account when the profile names none", async () => {
        sessions("DATABASE-TOKEN");

        await expect(acquireTokenFromVscodeAccount(DATABASE_SCOPE)).resolves.toBe("DATABASE-TOKEN");

        expect(getAccounts).not.toHaveBeenCalled();
        expect(getSession.mock.calls).toEqual([
            ["microsoft", [DATABASE_SCOPE], { account: undefined, silent: true }],
        ]);
    });

    it("finds the tenant of a profile saved without one, once per VS Code session", async () => {
        const work = account("single", "home-tenant");
        signedIn(work);
        sessions("DATABASE-TOKEN", "MANAGEMENT-TOKEN");
        const fetchMock = tenantList([
            { tenantId: "guest-tenant", displayName: "A guest tenant" },
            { tenantId: "home-tenant", displayName: "Home" },
        ]);

        await acquireTokenFromVscodeAccount(DATABASE_SCOPE, work.id);
        await acquireTokenFromVscodeAccount(DATABASE_SCOPE, work.id, "");

        // The home tenant is preferred to the first of the list, and the list is asked once.
        const request = [
            "microsoft",
            [DATABASE_SCOPE, "VSCODE_TENANT:home-tenant"],
            { account: work, silent: true },
        ];
        expect(databaseSessionCalls()).toEqual([request, request]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses the home tenant, with no prompt, when the tenants cannot be listed yet", async () => {
        const work = account("unlisted", "home-tenant");
        signedIn(work);
        sessions("DATABASE-TOKEN", undefined);

        await acquireTokenFromVscodeAccount(DATABASE_SCOPE, work.id);

        expect(databaseSessionCalls()).toEqual([
            [
                "microsoft",
                [DATABASE_SCOPE, "VSCODE_TENANT:home-tenant"],
                { account: work, silent: true },
            ],
        ]);
        // The management token is only ever asked silently.
        expect(
            getSession.mock.calls.filter(
                ([, scopes]: unknown[]) => (scopes as string[])[0] === MANAGEMENT_SCOPE,
            ),
        ).toEqual([["microsoft", [MANAGEMENT_SCOPE], { account: work, silent: true }]]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("signs a personal Microsoft account in to the tenant it is a guest of", async () => {
        const personal = account("personal-guest", MSA_TENANT_ID);
        signedIn(personal);
        sessions("DATABASE-TOKEN", "MANAGEMENT-TOKEN");
        tenantList([
            { tenantId: MSA_TENANT_ID },
            { tenantId: "guest-tenant", displayName: "Contoso" },
        ]);

        await acquireTokenFromVscodeAccount(DATABASE_SCOPE, personal.id);

        expect(databaseSessionCalls()).toEqual([
            [
                "microsoft",
                [DATABASE_SCOPE, "VSCODE_TENANT:guest-tenant"],
                { account: personal, silent: true },
            ],
        ]);
    });

    it("asks for the tenant of a personal Microsoft account when it cannot be found", async () => {
        const personal = account("personal-unknown", MSA_TENANT_ID, "someone@outlook.com");
        signedIn(personal);
        sessions("DATABASE-TOKEN", undefined);

        await expect(acquireTokenFromVscodeAccount(DATABASE_SCOPE, personal.id)).rejects.toThrow(
            "someone@outlook.com is a personal Microsoft account: edit the connection and enter the ID of the tenant it is a guest of.",
        );
        expect(databaseSessionCalls()).toEqual([]);
    });
});

describe("getTenantsForAccount", () => {
    it("lists the tenants from Azure Resource Manager with a token asked silently, by name, without the consumer tenant", async () => {
        const work = account("work", "home-tenant");
        sessions(undefined, "MANAGEMENT-TOKEN");
        const fetchMock = tenantList([
            { tenantId: "tenant-z", displayName: "Zeta" },
            { tenantId: "tenant-a", defaultDomain: "alpha.example" },
            { tenantId: MSA_TENANT_ID, displayName: "Microsoft Accounts" },
            { tenantId: "tenant-m" },
        ]);

        const tenants = await getTenantsForAccount(work);

        expect(tenants).toEqual([
            { tenantId: "tenant-a", displayName: "alpha.example" },
            { tenantId: "tenant-m", displayName: "tenant-m" },
            { tenantId: "tenant-z", displayName: "Zeta" },
        ]);
        expect(getSession.mock.calls).toEqual([
            ["microsoft", [MANAGEMENT_SCOPE], { account: work, silent: true }],
        ]);
        expect(fetchMock.mock.calls).toEqual([
            [
                "https://management.azure.com/tenants?api-version=2022-12-01",
                { headers: { Authorization: "Bearer MANAGEMENT-TOKEN" } },
            ],
        ]);
    });

    it("falls back to the home tenant when the list cannot be read", async () => {
        const work = account("work", "home-tenant");
        const homeOnly = [{ tenantId: "home-tenant", displayName: "home-tenant" }];
        sessions(undefined, "MANAGEMENT-TOKEN");

        tenantList([], 403);
        expect(await getTenantsForAccount(work)).toEqual(homeOnly);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Promise.reject(new Error("offline"))),
        );
        expect(await getTenantsForAccount(work)).toEqual(homeOnly);

        getSession.mockRejectedValue(new Error("canceled") as never);
        expect(await getTenantsForAccount(work)).toEqual(homeOnly);
        // A personal account has no tenant of its own to fall back to.
        expect(await getTenantsForAccount(account("personal", MSA_TENANT_ID))).toEqual([]);
    });
});

describe("account and tenant lists of the connection dialog", () => {
    it("lists the Microsoft accounts signed in to VS Code, by name", async () => {
        signedIn(
            account("b", "tenant", "zoe@contoso.com"),
            account("a", "tenant", "adam@contoso.com"),
        );

        expect(await getVscodeEntraAccountOptions()).toEqual([
            { displayName: "adam@contoso.com", value: "a.tenant" },
            { displayName: "zoe@contoso.com", value: "b.tenant" },
        ]);

        getAccounts.mockRejectedValue(new Error("no provider") as never);
        expect(await getVscodeEntraAccountOptions()).toEqual([]);
    });

    it("lists the tenants of the chosen account, and none without an account", async () => {
        const work = account("work", "home-tenant");
        signedIn(work);
        sessions(undefined, "MANAGEMENT-TOKEN");
        tenantList([{ tenantId: "home-tenant", displayName: "Contoso" }]);

        expect(await getVscodeEntraTenantOptions(work.id)).toEqual([
            { displayName: "Contoso (home-tenant)", value: "home-tenant" },
        ]);
        expect(await getVscodeEntraTenantOptions("unknown.account")).toEqual([]);
        expect(await getVscodeEntraTenantOptions(undefined)).toEqual([]);
    });
});

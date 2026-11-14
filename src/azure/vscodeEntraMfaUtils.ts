/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Entra ID (MFA) through the Microsoft accounts signed in to VS Code, as vscode-mssql does
// when `mssql.useMsalEntraMfaAuth` is off (its default). Microsoft goes through
// @microsoft/vscode-azext-azureauth; the few calls it needs are made directly here.

import * as vscode from "vscode";
import { FormItemOptions } from "../sharedInterfaces/form";
import { logger } from "../models/logger";
import { getErrorMessage } from "../utils/utils";

const AUTH_PROVIDER_ID = "microsoft";
const ARM_SCOPE = "https://management.azure.com/.default";
const ARM_TENANTS_URL = "https://management.azure.com/tenants?api-version=2022-12-01";

const entraLogger = logger.withPrefix("VscodeEntra");

/** Default tenant of each account, found once per VS Code session. */
const defaultTenants = new Map<string, string>();

/** Home tenant of every personal Microsoft account; its tokens never open an Azure database. */
export const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

export interface EntraTenant {
    tenantId: string;
    displayName: string;
}

/**
 * Determines if the provided account IDs are compatible, meaning they are either exactly the same or one is a prefix of the other.
 */
export function areCompatibleEntraAccountIds(
    currentAccountId?: string,
    expectedAccountId?: string,
): boolean {
    const normalizedCurrentAccountId = currentAccountId?.toLowerCase();
    const normalizedExpectedAccountId = expectedAccountId?.toLowerCase();

    return (
        !!normalizedCurrentAccountId &&
        !!normalizedExpectedAccountId &&
        (normalizedCurrentAccountId === normalizedExpectedAccountId ||
            normalizedCurrentAccountId.startsWith(normalizedExpectedAccountId) ||
            normalizedExpectedAccountId.startsWith(normalizedCurrentAccountId))
    );
}

export async function getVscodeEntraAccounts(): Promise<
    vscode.AuthenticationSessionAccountInformation[]
> {
    try {
        return Array.from(await vscode.authentication.getAccounts(AUTH_PROVIDER_ID)).sort((a, b) =>
            a.label.localeCompare(b.label),
        );
    } catch (error) {
        entraLogger.error(`Error fetching VS Code accounts: ${getErrorMessage(error)}`);
        return [];
    }
}

export async function getVscodeEntraAccountOptions(): Promise<FormItemOptions[]> {
    const accounts = await getVscodeEntraAccounts();
    return accounts.map((account) => ({
        displayName: account.label,
        value: account.id,
    }));
}

export async function resolveVscodeEntraAccount(
    accountId?: string,
): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
    if (!accountId) {
        return undefined;
    }
    const accounts = await getVscodeEntraAccounts();
    return (
        accounts.find((account) => account.id === accountId) ??
        accounts.find((account) => areCompatibleEntraAccountIds(account.id, accountId))
    );
}

/** VS Code account IDs take the format <objectId>.<homeTenantId>. */
export function getHomeTenantIdForAccount(accountId: string): string | undefined {
    if (accountId?.includes(".")) {
        return accountId.split(".")[1];
    }
    return undefined;
}

/** Personal Microsoft accounts reach Azure only as guests of another tenant, which must be chosen. */
export function isPersonalMicrosoftAccount(accountId?: string): boolean {
    return !!accountId && getHomeTenantIdForAccount(accountId) === MSA_TENANT_ID;
}

/**
 * Tenants the account belongs to, read from Azure Resource Manager (read only). When the
 * account has not given a management token silently yet, only its home tenant is returned
 * (nothing for a personal account), so that opening the dialog never shows a sign-in prompt.
 */
export async function getTenantsForAccount(
    account: vscode.AuthenticationSessionAccountInformation,
): Promise<EntraTenant[]> {
    const homeTenantId = getHomeTenantIdForAccount(account.id);
    const homeOnly =
        homeTenantId && homeTenantId !== MSA_TENANT_ID
            ? [{ tenantId: homeTenantId, displayName: homeTenantId }]
            : [];
    try {
        const session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, [ARM_SCOPE], {
            account,
            silent: true,
        });
        if (!session) {
            entraLogger.info(
                `Tenant discovery for ${account.label}: no management token yet, home tenant only.`,
            );
            return homeOnly;
        }
        const response = await fetch(ARM_TENANTS_URL, {
            headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        const body = (await response.json()) as {
            value?: { tenantId: string; displayName?: string; defaultDomain?: string }[];
        };
        entraLogger.info(
            `Tenant discovery for ${account.label}: token issued by tenant ${tokenTenantId(session.accessToken)}, ` +
                `Azure Resource Manager lists [${(body.value ?? []).map((t) => t.tenantId).join(", ")}]`,
        );
        const tenants = (body.value ?? [])
            .filter((t) => t.tenantId !== MSA_TENANT_ID)
            .map((t) => ({
                tenantId: t.tenantId,
                displayName: t.displayName ?? t.defaultDomain ?? t.tenantId,
            }));
        return tenants.sort((a, b) => a.displayName.localeCompare(b.displayName));
    } catch (error) {
        entraLogger.error(
            `Tenant discovery failed for account ${account.label}: ${getErrorMessage(error)}`,
        );
        return homeOnly;
    }
}

/** The `tid` claim of an access token, for diagnostics. */
function tokenTenantId(token: string): string {
    try {
        return (
            JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).tid ?? "?"
        );
    } catch {
        return "?";
    }
}

export async function getVscodeEntraTenantOptions(accountId?: string): Promise<FormItemOptions[]> {
    const account = await resolveVscodeEntraAccount(accountId);
    const tenants = account ? await getTenantsForAccount(account) : [];
    return tenants.map((tenant) => ({
        displayName: `${tenant.displayName} (${tenant.tenantId})`,
        value: tenant.tenantId,
    }));
}

export function getDefaultTenantId(accountId: string, tenants: EntraTenant[]): string {
    if (accountId === "" || tenants.length === 0) return "";

    // Response from VS Code account system shows all tenants as "Home", so we need to extract the home tenant ID manually
    const homeTenantId = getHomeTenantIdForAccount(accountId);

    // For personal Microsoft accounts, the extracted tenant ID may not be one that the user has access to.
    // Only use the extracted tenant ID if it's in the tenant list; otherwise, default to the first.
    return tenants.some((t) => t.tenantId === homeTenantId) ? homeTenantId! : tenants[0].tenantId;
}

/**
 * Acquires an access token for the given scope (e.g. "https://database.windows.net/.default")
 * from VS Code's authentication provider. Without an account, VS Code picks one (and may ask).
 * VS Code refreshes the token when it is about to expire.
 */
export async function acquireTokenFromVscodeAccount(
    scope: string,
    accountId?: string,
    tenantId?: string,
): Promise<string> {
    let account: vscode.AuthenticationSessionAccountInformation | undefined;
    if (accountId) {
        account = await resolveVscodeEntraAccount(accountId);
        if (!account) {
            throw new MissingEntraAuthAccountError(
                vscode.l10n.t(
                    "The Microsoft account {0} is not signed in to VS Code. Sign in from the Accounts menu, or edit the connection to pick another account.",
                    accountId,
                ),
            );
        }
    }

    let resolvedTenantId = tenantId?.trim() || undefined;
    if (!resolvedTenantId && account) {
        // Profiles of single-tenant accounts are saved without a tenant (the field is hidden):
        // look it up once per VS Code session rather than on every physical connection.
        resolvedTenantId = defaultTenants.get(account.id);
        if (!resolvedTenantId) {
            resolvedTenantId =
                getDefaultTenantId(account.id, await getTenantsForAccount(account)) || undefined;
            if (resolvedTenantId) {
                defaultTenants.set(account.id, resolvedTenantId);
            }
        }
        if (!resolvedTenantId && isPersonalMicrosoftAccount(account.id)) {
            throw new Error(
                vscode.l10n.t(
                    "{0} is a personal Microsoft account: edit the connection and enter the ID of the tenant it is a guest of.",
                    account.label,
                ),
            );
        }
    }

    const scopes = resolvedTenantId ? [scope, `VSCODE_TENANT:${resolvedTenantId}`] : [scope];
    const session =
        (await vscode.authentication.getSession(AUTH_PROVIDER_ID, scopes, {
            account,
            silent: true,
        })) ??
        (await vscode.authentication.getSession(AUTH_PROVIDER_ID, scopes, {
            account,
            createIfNone: true,
        }));
    if (!session) {
        throw new Error(
            vscode.l10n.t(
                "Unable to get a Microsoft Entra ID token from VS Code for {0}.",
                account?.label ?? scope,
            ),
        );
    }
    return session.accessToken;
}

export class MissingEntraAuthAccountError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MissingEntraAuthAccountError";
        // Set the prototype explicitly to maintain the correct prototype chain
        Object.setPrototypeOf(this, MissingEntraAuthAccountError.prototype);
    }
}

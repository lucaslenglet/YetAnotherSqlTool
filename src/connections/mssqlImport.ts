/**
 * Turns the connections and connection groups of Microsoft's SQL Server extension (vscode-mssql,
 * settings `mssql.connections` and `mssql.connectionGroups`) into what YAST adds to its own
 * settings, and says what it could not carry over.
 *
 * Pure: no `vscode` call, nothing is read or written here. The settings are JSON edited by hand,
 * so every entry is checked: a bad entry becomes a refusal or a warning, never an exception.
 * Messages never contain a password, a token or a connection string, only key names.
 */

import { parseConnectionColor } from "./connectionColor";

/** Authentication types of vscode-mssql that YAST handles (`AuthenticationType` in the drivers). */
const SUPPORTED_AUTHENTICATION_TYPES = [
    "SqlLogin",
    "Integrated",
    "AzureMFA",
    "ActiveDirectoryDefault",
    "ActiveDirectoryServicePrincipal",
];

type ValueKind = "string" | "number" | "boolean" | "encrypt" | "intent";

/**
 * Profile keys the SQL Server driver really uses (see `connectionOptions.ts`) or the extension
 * itself needs, with the type of their value. Every other key of a vscode-mssql profile
 * (pooling, retry, Always Encrypted, MARS... which the driver ignores) is left out and reported.
 */
export const IMPORTED_PROFILE_KEYS: Readonly<Record<string, ValueKind>> = {
    server: "string",
    database: "string",
    user: "string",
    email: "string",
    accountId: "string",
    tenantId: "string",
    port: "number",
    encrypt: "encrypt",
    trustServerCertificate: "boolean",
    hostNameInCertificate: "string",
    connectTimeout: "number",
    commandTimeout: "number",
    applicationName: "string",
    workstationId: "string",
    applicationIntent: "intent",
    currentLanguage: "string",
    multiSubnetFailover: "boolean",
    packetSize: "number",
    profileName: "string",
    savePassword: "boolean",
    emptyPasswordInput: "boolean",
    order: "number",
};

/** Keys handled one by one rather than copied. */
const SPECIAL_KEYS = new Set(["id", "groupId", "authenticationType", "password"]);

/** Keys vscode-mssql writes with no meaning for a connection (legacy account setting): not reported. */
const IGNORED_KEYS = new Set(["azureAuthType"]);

/** The name vscode-mssql gives itself in every connection; YAST keeps its own. */
const MSSQL_APPLICATION_NAME = "vscode-mssql";

/** `<object id>.<tenant id>`, the form of the accounts of VS Code's Microsoft provider. */
const ACCOUNT_ID_PATTERN = /^[^.\s]+\.[^.\s]+$/;

export interface ExistingGroup {
    id: string;
    name: string;
    parentId?: string;
    /** Only user settings groups can be reused: a workspace group is not there in other windows. */
    inUserSettings: boolean;
}

export interface ExistingProfile {
    id?: string;
    provider?: string;
    server?: string;
    port?: number | string;
    database?: string;
    user?: string;
    accountId?: string;
    authenticationType?: string;
}

export interface ExistingState {
    profiles: readonly ExistingProfile[];
    groups: readonly ExistingGroup[];
    /** Id of YAST's root group. */
    rootGroupId: string;
}

/** A profile as YAST stores it, before the store fills id, group and config source. */
export type ImportedProfile = Record<string, string | number | boolean | undefined> & {
    server: string;
};

export interface ImportedGroup {
    id: string;
    name: string;
    parentId: string;
    color?: string;
    description?: string;
    order?: number;
}

interface SourceGroup {
    id: string;
    name: string;
    /** Id of the parent group; undefined when the group is a child of the root. */
    parentId: string | undefined;
    color?: string;
    description?: string;
    order?: number;
    warnings: string[];
}

export interface ImportCandidate {
    /** Position in `mssql.connections`, identifies the candidate. */
    key: number;
    label: string;
    /** Names of the groups from the root's child down to the profile's group. */
    groupPath: string[];
    /** The vscode-mssql groups the profile sits in, from the root's child down; empty at the root. */
    groupChain: SourceGroup[];
    profile: ImportedProfile;
    /** Why this profile is probably in YAST already; undefined when it is not. */
    alreadyPresent?: string;
    /** Keys left out because YAST does not support them (names only). */
    unsupportedKeys: string[];
    /** What was left out or changed, other than unsupported keys. */
    warnings: string[];
    /** What the user has to do after the import (password, account). */
    actions: string[];
}

export interface ImportRefusal {
    label: string;
    reason: string;
}

export interface MssqlAnalysis {
    candidates: ImportCandidate[];
    refused: ImportRefusal[];
    /** Problems with the settings themselves (groups, entries that are not objects). */
    notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
    return value === undefined || value === null || value === "";
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

function finiteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
    return undefined;
}

// -- groups ------------------------------------------------------------------------------------

interface GroupTree {
    groups: Map<string, SourceGroup>;
    /** Ids that mean "the root": "ROOT", and the id of a legacy root (named ROOT, with a uuid). */
    rootIds: Set<string>;
}

function readGroups(raw: unknown, notes: string[]): GroupTree {
    const groups = new Map<string, SourceGroup>();
    const rootIds = new Set<string>(["ROOT"]);
    if (raw === undefined || raw === null) return { groups, rootIds };
    if (!Array.isArray(raw)) {
        notes.push("mssql.connectionGroups is not a list: groups were not imported.");
        return { groups, rootIds };
    }

    raw.forEach((entry, index) => {
        const position = `Connection group #${index + 1} of mssql.connectionGroups`;
        if (!isRecord(entry)) {
            notes.push(`${position} is not an object: ignored.`);
            return;
        }
        if (!nonEmptyString(entry.id) || !nonEmptyString(entry.name)) {
            notes.push(`${position} has no id or no name: ignored.`);
            return;
        }
        const parentId = nonEmptyString(entry.parentId) ? entry.parentId : undefined;
        if (entry.id === "ROOT" || (entry.name === "ROOT" && parentId === undefined)) {
            rootIds.add(entry.id);
            return;
        }
        if (groups.has(entry.id)) {
            notes.push(`Connection group "${entry.name}" appears twice: the first one is used.`);
            return;
        }
        const warnings: string[] = [];
        const group: SourceGroup = { id: entry.id, name: entry.name, parentId, warnings };
        if (!isEmpty(entry.color)) {
            const color = parseConnectionColor(entry.color);
            if (color) group.color = color;
            else warnings.push("its color is not in the form #RRGGBB: left out");
        }
        if (typeof entry.description === "string" && entry.description !== "") {
            group.description = entry.description;
        } else if (!isEmpty(entry.description)) {
            warnings.push("its description is not text: left out");
        }
        if (!isEmpty(entry.order)) {
            const order = finiteNumber(entry.order);
            if (order !== undefined && order >= 0) group.order = order;
            else warnings.push("its order is not a number: left out");
        }
        groups.set(entry.id, group);
    });
    return { groups, rootIds };
}

/**
 * The chain of groups from the root's child down to `groupId`. A parent that does not exist, or a
 * loop, ends the chain at the root, with a note.
 */
function groupChain(
    groupId: string,
    tree: GroupTree,
    notes: string[],
    reported: Set<string>,
): SourceGroup[] {
    const chain: SourceGroup[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = groupId;
    while (currentId !== undefined && !tree.rootIds.has(currentId)) {
        const group = tree.groups.get(currentId);
        if (!group || seen.has(currentId)) {
            // The chain is built top-down: its first group is the one with the broken parent.
            const culprit = chain[0];
            if (!reported.has(culprit?.id ?? groupId)) {
                reported.add(culprit?.id ?? groupId);
                notes.push(
                    `The parent of connection group "${culprit?.name ?? groupId}" ` +
                        `is missing or loops: the group is placed at the root.`,
                );
            }
            break;
        }
        seen.add(currentId);
        chain.unshift(group);
        currentId = group.parentId;
    }
    return chain;
}

// -- profiles ----------------------------------------------------------------------------------

function describe(raw: Record<string, unknown>): string {
    if (nonEmptyString(raw.profileName)) return raw.profileName;
    const database = nonEmptyString(raw.database) ? raw.database : "<default>";
    const auth = typeof raw.authenticationType === "string" ? raw.authenticationType : "SqlLogin";
    const who =
        auth === "SqlLogin" || auth === "Integrated"
            ? (raw.user as string | undefined)
            : auth === "AzureMFA"
              ? (raw.email as string | undefined)
              : auth;
    return `${typeof raw.server === "string" ? raw.server : "?"}, ${database} (${typeof who === "string" ? who : ""})`;
}

function sameProfileKey(p: ExistingProfile | ImportedProfile): string {
    return JSON.stringify([
        String(p.server ?? "")
            .trim()
            .toLowerCase(),
        p.port === undefined || p.port === "" || p.port === 0 ? "" : String(p.port),
        // No database means master, as in Microsoft's own comparison.
        String(p.database || "master").toLowerCase(),
        String(p.authenticationType || "SqlLogin"),
        String(p.user ?? "").toLowerCase(),
        p.authenticationType === "AzureMFA" ? String(p.accountId ?? "").toLowerCase() : "",
    ]);
}

function readProfile(
    raw: unknown,
    index: number,
    tree: GroupTree,
    notes: string[],
    reportedGroups: Set<string>,
): ImportCandidate | ImportRefusal {
    const position = `Connection #${index + 1} of mssql.connections`;
    if (!isRecord(raw)) {
        return { label: position, reason: "it is not an object." };
    }
    const label = describe(raw);

    if (!nonEmptyString(raw.server)) {
        return {
            label: nonEmptyString(raw.profileName) ? raw.profileName : position,
            reason: nonEmptyString(raw.connectionString)
                ? "it is defined by a connection string only, which YAST does not import."
                : "it has no server name.",
        };
    }

    let authenticationType = "SqlLogin";
    if (!isEmpty(raw.authenticationType)) {
        if (typeof raw.authenticationType !== "string") {
            return { label, reason: "its authentication type is not text." };
        }
        if (!SUPPORTED_AUTHENTICATION_TYPES.includes(raw.authenticationType)) {
            return {
                label,
                reason: `the authentication type "${raw.authenticationType}" is not supported by YAST.`,
            };
        }
        authenticationType = raw.authenticationType;
    }

    const profile: ImportedProfile = { server: raw.server.trim(), authenticationType };
    const unsupportedKeys: string[] = [];
    const warnings: string[] = [];
    const actions: string[] = [];

    for (const [key, value] of Object.entries(raw)) {
        if (SPECIAL_KEYS.has(key) || IGNORED_KEYS.has(key) || isEmpty(value) || key === "server") {
            continue;
        }
        if (key === "applicationName" && value === MSSQL_APPLICATION_NAME) continue;
        const kind = IMPORTED_PROFILE_KEYS[key];
        if (!kind) {
            unsupportedKeys.push(key);
            continue;
        }
        const converted = convert(kind, value);
        if (converted === undefined) {
            warnings.push(`the value of "${key}" is not valid: left out.`);
        } else {
            profile[key] = converted;
        }
    }

    if (profile.accountId !== undefined && !ACCOUNT_ID_PATTERN.test(String(profile.accountId))) {
        delete profile.accountId;
        warnings.push(`its Entra ID account has a form YAST does not know: left out.`);
    }

    // The id lets a second import recognize this profile; the store makes one when it is missing.
    if (nonEmptyString(raw.id)) profile.id = raw.id;
    if (typeof raw.connectionString === "string" && raw.connectionString !== "") {
        warnings.push("its connection string is not imported.");
    }

    // vscode-mssql keeps passwords in its own SecretStorage, which YAST cannot read. A password
    // written in settings goes where YAST's own store puts it: SecretStorage with "Save Password".
    const plaintextPassword = typeof raw.password === "string" ? raw.password : "";
    if (plaintextPassword !== "") {
        if (profile.savePassword === true) {
            profile.password = plaintextPassword;
        } else {
            warnings.push(
                'its password, written in the settings, is not imported because "Save Password" is off.',
            );
        }
    }
    const hasPassword = plaintextPassword !== "" && profile.savePassword === true;
    const askedLater = (what: string) =>
        profile.savePassword === true
            ? `${what} is asked at the first connection, then saved.`
            : `${what} is asked at the first connection.`;

    switch (authenticationType) {
        case "SqlLogin":
            if (!hasPassword && profile.emptyPasswordInput !== true) {
                actions.push(askedLater("the password"));
            }
            break;
        case "ActiveDirectoryServicePrincipal":
            if (!hasPassword && profile.emptyPasswordInput !== true) {
                actions.push(askedLater("the client secret"));
            }
            break;
        case "Integrated":
            actions.push(
                "Windows Authentication works differently in YAST: it signs in with an account " +
                    "and its password (NTLM), not with the Windows session. Edit the connection " +
                    "to enter the account as DOMAIN\\user" +
                    (hasPassword ? "." : "; the password is asked at the first connection."),
            );
            break;
        case "AzureMFA":
            if (profile.accountId === undefined) {
                actions.push("the Microsoft account is chosen at the first connection.");
            }
            break;
    }

    // Group of the profile.
    let chain: SourceGroup[] = [];
    if (nonEmptyString(raw.groupId) && !tree.rootIds.has(raw.groupId)) {
        if (tree.groups.has(raw.groupId)) {
            chain = groupChain(raw.groupId, tree, notes, reportedGroups);
        } else {
            warnings.push(
                "its group does not exist in mssql.connectionGroups: placed at the root.",
            );
        }
    } else if (!isEmpty(raw.groupId) && typeof raw.groupId !== "string") {
        warnings.push("its group is not valid: placed at the root.");
    }

    return {
        key: index,
        label,
        groupPath: chain.map((g) => g.name),
        groupChain: chain,
        profile,
        unsupportedKeys,
        warnings,
        actions,
    };
}

function convert(kind: ValueKind, value: unknown): string | number | boolean | undefined {
    switch (kind) {
        case "string":
            return typeof value === "string" ? value : undefined;
        case "number":
            return finiteNumber(value);
        case "boolean":
            return typeof value === "boolean" ? value : undefined;
        case "encrypt":
            return typeof value === "boolean" ||
                (typeof value === "string" &&
                    ["Optional", "Mandatory", "Strict", "true", "false"].includes(value))
                ? value
                : undefined;
        case "intent":
            return value === "ReadWrite" || value === "ReadOnly" ? value : undefined;
    }
}

/**
 * Reads the settings of vscode-mssql. `connections` and `groups` are the raw values of
 * `mssql.connections` and `mssql.connectionGroups` (anything, as the user may have typed it).
 */
export function analyzeMssqlSettings(
    connections: unknown,
    groups: unknown,
    existing: ExistingState,
): MssqlAnalysis {
    const notes: string[] = [];
    const tree = readGroups(groups, notes);
    const candidates: ImportCandidate[] = [];
    const refused: ImportRefusal[] = [];

    if (connections !== undefined && connections !== null && !Array.isArray(connections)) {
        notes.push("mssql.connections is not a list: nothing to import.");
    }
    const reportedGroups = new Set<string>();
    const entries = Array.isArray(connections) ? connections : [];

    const existingIds = new Set(existing.profiles.map((p) => p.id).filter(Boolean));
    const existingKeys = new Set(
        existing.profiles
            .filter((p) => (p.provider ?? "mssql") === "mssql")
            .map((p) => sameProfileKey(p)),
    );
    const seenInList = new Map<string, string>();

    entries.forEach((entry, index) => {
        let result: ImportCandidate | ImportRefusal;
        try {
            result = readProfile(entry, index, tree, notes, reportedGroups);
        } catch {
            result = {
                label: `Connection #${index + 1} of mssql.connections`,
                reason: "it could not be read.",
            };
        }
        if (!("key" in result)) {
            refused.push(result);
            return;
        }
        const profileKey = sameProfileKey(result.profile);
        if (typeof result.profile.id === "string" && existingIds.has(result.profile.id)) {
            result.alreadyPresent = "already in YAST (imported before)";
        } else if (existingKeys.has(profileKey)) {
            result.alreadyPresent = "already in YAST";
        } else if (seenInList.has(profileKey)) {
            result.alreadyPresent = `same as "${seenInList.get(profileKey)}"`;
        }
        if (!seenInList.has(profileKey)) seenInList.set(profileKey, result.label);
        candidates.push(result);
    });

    return { candidates, refused, notes };
}

// -- plan --------------------------------------------------------------------------------------

export interface ImportPlan {
    /** Groups to create, parents before children. */
    groupsToAdd: ImportedGroup[];
    /** Existing groups that were reused. */
    groupsReused: number;
    profilesToAdd: ImportedProfile[];
    /** The selected candidates, in the order of `profilesToAdd`. */
    imported: ImportCandidate[];
    /** Candidates that were not selected. */
    skipped: ImportCandidate[];
    /** Problems with groups that were created (invalid color...). */
    groupWarnings: string[];
}

/**
 * What to write for the selected candidates. A group is recognized in YAST, in this order, by its
 * id (kept from vscode-mssql, so a second import finds the groups of the first one), then by its
 * name under the same parent (groups the user made by hand). Only the groups the selected
 * profiles need are created. A profile never replaces a profile of YAST: when its id is taken,
 * it gets a new one.
 */
export function buildImportPlan(
    analysis: MssqlAnalysis,
    selectedKeys: ReadonlySet<number>,
    existing: ExistingState,
    newId: () => string,
): ImportPlan {
    const reusable = existing.groups.filter((g) => g.inUserSettings);
    const takenGroupIds = new Set(existing.groups.map((g) => g.id));
    const takenProfileIds = new Set(existing.profiles.map((p) => p.id).filter(Boolean));
    const resolved = new Map<string, string>();
    const groupsToAdd: ImportedGroup[] = [];
    const groupWarnings: string[] = [];
    const reused = new Set<string>();

    const resolve = (chain: readonly SourceGroup[]): string => {
        let parentId = existing.rootGroupId;
        for (const group of chain) {
            let id = resolved.get(group.id);
            if (!id) {
                const match =
                    reusable.find((g) => g.id === group.id) ??
                    reusable.find(
                        (g) =>
                            g.name === group.name &&
                            (g.parentId ?? existing.rootGroupId) === parentId,
                    );
                if (match) {
                    id = match.id;
                    reused.add(id);
                } else {
                    id = takenGroupIds.has(group.id) ? newId() : group.id;
                    takenGroupIds.add(id);
                    const added: ImportedGroup = { id, name: group.name, parentId };
                    if (group.color) added.color = group.color;
                    if (group.description) added.description = group.description;
                    if (group.order !== undefined) added.order = group.order;
                    groupsToAdd.push(added);
                    for (const warning of group.warnings) {
                        groupWarnings.push(`Group "${group.name}": ${warning}.`);
                    }
                }
                resolved.set(group.id, id);
            }
            parentId = id;
        }
        return parentId;
    };

    const imported: ImportCandidate[] = [];
    const skipped: ImportCandidate[] = [];
    const profilesToAdd: ImportedProfile[] = [];
    for (const candidate of analysis.candidates) {
        if (!selectedKeys.has(candidate.key)) {
            skipped.push(candidate);
            continue;
        }
        const profile: ImportedProfile = { ...candidate.profile };
        profile.groupId = resolve(candidate.groupChain);
        if (typeof profile.id === "string") {
            if (takenProfileIds.has(profile.id)) delete profile.id;
            else takenProfileIds.add(profile.id);
        }
        profilesToAdd.push(profile);
        imported.push(candidate);
    }
    return {
        groupsToAdd,
        groupsReused: reused.size,
        profilesToAdd,
        imported,
        skipped,
        groupWarnings,
    };
}

// -- report ------------------------------------------------------------------------------------

export interface ImportOutcome {
    plan: ImportPlan;
    /** Keys of the candidates that could not be saved. */
    failed: number[];
}

export interface ImportSummary {
    imported: number;
    groupsCreated: number;
    skipped: number;
    refused: number;
    /** Imported profiles with something left out. */
    withWarnings: number;
    /** Imported profiles that need a password or an account. */
    withActions: number;
}

export function summarize(analysis: MssqlAnalysis, outcome: ImportOutcome): ImportSummary {
    const failed = new Set(outcome.failed);
    const done = outcome.plan.imported.filter((c) => !failed.has(c.key));
    return {
        imported: done.length,
        groupsCreated: outcome.plan.groupsToAdd.length,
        skipped: outcome.plan.skipped.length,
        refused: analysis.refused.length,
        withWarnings: done.filter((c) => c.unsupportedKeys.length > 0 || c.warnings.length > 0)
            .length,
        withActions: done.filter((c) => c.actions.length > 0).length,
    };
}

/** The detail of the import, one line per fact, for the output channel. No secret in it. */
export function formatReport(analysis: MssqlAnalysis, outcome: ImportOutcome): string[] {
    const { plan } = outcome;
    const failed = new Set(outcome.failed);
    const lines: string[] = [];
    const where = (c: ImportCandidate) =>
        c.groupPath.length > 0 ? ` [${c.groupPath.join(" / ")}]` : "";

    lines.push(
        `Imported ${plan.imported.length - failed.size} connection(s), created ${plan.groupsToAdd.length} group(s), ` +
            `reused ${plan.groupsReused} group(s).`,
    );
    for (const note of analysis.notes) lines.push(`Settings: ${note}`);
    for (const warning of plan.groupWarnings) lines.push(warning);
    for (const refusal of analysis.refused) {
        lines.push(`Not imported: "${refusal.label}": ${refusal.reason}`);
    }
    for (const c of plan.imported) {
        if (failed.has(c.key)) lines.push(`Not imported: "${c.label}": it could not be saved.`);
    }
    for (const c of plan.skipped) {
        lines.push(
            `Skipped: "${c.label}"${where(c)}${c.alreadyPresent ? ` (${c.alreadyPresent})` : ""}.`,
        );
    }
    for (const c of plan.imported) {
        if (failed.has(c.key)) continue;
        const parts: string[] = [];
        if (c.unsupportedKeys.length > 0) {
            parts.push(`left out, not supported by YAST: ${c.unsupportedKeys.join(", ")}`);
        }
        parts.push(...c.warnings.map((w) => w.replace(/\.$/, "")));
        parts.push(...c.actions.map((a) => `to do: ${a.replace(/\.$/, "")}`));
        if (parts.length > 0) lines.push(`"${c.label}"${where(c)}: ${parts.join("; ")}.`);
    }
    return lines;
}

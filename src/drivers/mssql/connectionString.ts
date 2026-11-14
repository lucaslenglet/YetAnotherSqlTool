import type { ConnectionOptionValues } from "../types";
import { AuthenticationType } from "../types";

// ADO.NET / Microsoft.Data.SqlClient connection strings, behaving like SqlConnectionStringBuilder
// (the parser behind sqltoolsservice's connection/parseConnectionString and getconnectionstring).

type OptionKind = "string" | "number" | "boolean" | "category";

interface KeywordSpec {
    option: string;
    kind: OptionKind;
    /** Allowed values for "category" options, spelled as the option values. */
    values?: string[];
}

/** Keys are normalized: lower case, without spaces, underscores or hyphens. */
const KEYWORDS: Record<string, KeywordSpec> = {};

function register(spec: KeywordSpec, ...keywords: string[]): void {
    for (const keyword of keywords) KEYWORDS[normalizeKey(keyword)] = spec;
}

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[\s_-]+/g, "");
}

register(
    { option: "server", kind: "string" },
    "Data Source",
    "Server",
    "Address",
    "Addr",
    "Network Address",
);
register({ option: "database", kind: "string" }, "Initial Catalog", "Database");
register({ option: "user", kind: "string" }, "User ID", "UID", "User");
register({ option: "password", kind: "string" }, "Password", "PWD");
register(
    { option: "encrypt", kind: "category", values: ["Optional", "Mandatory", "Strict"] },
    "Encrypt",
);
register(
    { option: "trustServerCertificate", kind: "boolean" },
    "Trust Server Certificate",
    "TrustServerCertificate",
);
register({ option: "hostNameInCertificate", kind: "string" }, "Host Name In Certificate");
register({ option: "applicationName", kind: "string" }, "Application Name", "App");
register(
    { option: "connectTimeout", kind: "number" },
    "Connect Timeout",
    "Connection Timeout",
    "Timeout",
);
register({ option: "commandTimeout", kind: "number" }, "Command Timeout");
register(
    { option: "applicationIntent", kind: "category", values: ["ReadWrite", "ReadOnly"] },
    "Application Intent",
    "ApplicationIntent",
);
register(
    { option: "multiSubnetFailover", kind: "boolean" },
    "Multi Subnet Failover",
    "MultiSubnetFailover",
);
register({ option: "packetSize", kind: "number" }, "Packet Size");
register({ option: "workstationId", kind: "string" }, "Workstation ID", "WSID");
register({ option: "currentLanguage", kind: "string" }, "Current Language", "Language");
register(
    { option: "persistSecurityInfo", kind: "boolean" },
    "Persist Security Info",
    "PersistSecurityInfo",
);
register({ option: "failoverPartner", kind: "string" }, "Failover Partner");
register({ option: "pooling", kind: "boolean" }, "Pooling");
register({ option: "minPoolSize", kind: "number" }, "Min Pool Size");
register({ option: "maxPoolSize", kind: "number" }, "Max Pool Size");
register(
    { option: "loadBalanceTimeout", kind: "number" },
    "Load Balance Timeout",
    "Connection Lifetime",
);
register(
    { option: "connectRetryCount", kind: "number" },
    "Connect Retry Count",
    "ConnectRetryCount",
);
register(
    { option: "connectRetryInterval", kind: "number" },
    "Connect Retry Interval",
    "ConnectRetryInterval",
);
register({ option: "replication", kind: "boolean" }, "Replication");
register(
    { option: "multipleActiveResultSets", kind: "boolean" },
    "Multiple Active Result Sets",
    "MultipleActiveResultSets",
);
register(
    { option: "attachDbFilename", kind: "string" },
    "AttachDbFilename",
    "Extended Properties",
    "Initial File Name",
);
register({ option: "typeSystemVersion", kind: "string" }, "Type System Version");
register({ option: "enclaveAttestationUrl", kind: "string" }, "Enclave Attestation Url");
register(
    { option: "columnEncryptionSetting", kind: "category", values: ["Disabled", "Enabled"] },
    "Column Encryption Setting",
);
register(
    { option: "attestationProtocol", kind: "category", values: ["HGS", "AAS", "None"] },
    "Attestation Protocol",
);

const PORT_SPEC: KeywordSpec = { option: "port", kind: "number" };

const AUTHENTICATION_KEYWORDS: Record<string, string> = {
    notspecified: AuthenticationType.SqlLogin,
    sqlpassword: AuthenticationType.SqlLogin,
    activedirectoryinteractive: AuthenticationType.AzureMFA,
    activedirectorydefault: "ActiveDirectoryDefault",
    activedirectoryserviceprincipal: "ActiveDirectoryServicePrincipal",
    activedirectorypassword: "ActiveDirectoryPassword",
    activedirectoryintegrated: "ActiveDirectoryIntegrated",
    activedirectorymanagedidentity: "ActiveDirectoryManagedIdentity",
    activedirectorymsi: "ActiveDirectoryManagedIdentity",
    activedirectorydevicecodeflow: "ActiveDirectoryDeviceCodeFlow",
    activedirectoryworkloadidentity: "ActiveDirectoryWorkloadIdentity",
};

/** option value -> text used after "Authentication=" */
const AUTHENTICATION_TEXT: Record<string, string> = {
    SqlLogin: "SqlPassword",
    AzureMFA: "Active Directory Interactive",
    ActiveDirectoryDefault: "Active Directory Default",
    ActiveDirectoryServicePrincipal: "Active Directory Service Principal",
    ActiveDirectoryPassword: "Active Directory Password",
    ActiveDirectoryIntegrated: "Active Directory Integrated",
    ActiveDirectoryManagedIdentity: "Active Directory Managed Identity",
    ActiveDirectoryDeviceCodeFlow: "Active Directory Device Code Flow",
    ActiveDirectoryWorkloadIdentity: "Active Directory Workload Identity",
};

/** Splits "k=v;k=v" following the ADO.NET rules (quoted values, doubled quote escape, empty segments). */
function tokenize(text: string): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    let i = 0;
    const length = text.length;
    while (i < length) {
        while (i < length && (text[i] === ";" || /\s/.test(text[i]))) i++;
        if (i >= length) break;

        const keyStart = i;
        while (i < length && text[i] !== "=" && text[i] !== ";") i++;
        if (i >= length || text[i] !== "=") {
            throw new Error(
                `Format of the connection string is not valid: expected "=" after "${text.slice(keyStart, i).trim()}" (at position ${keyStart + 1}).`,
            );
        }
        const key = text.slice(keyStart, i).trim();
        if (!key)
            throw new Error(
                `Format of the connection string is not valid: a key is missing before "=" (at position ${i + 1}).`,
            );
        i++; // "="

        while (i < length && /\s/.test(text[i])) i++;
        let value: string;
        if (text[i] === "'" || text[i] === '"') {
            const quote = text[i];
            const quoteStart = i;
            i++;
            value = "";
            for (;;) {
                if (i >= length)
                    throw new Error(
                        `Format of the connection string is not valid: the quoted value of "${key}" is not closed (at position ${quoteStart + 1}).`,
                    );
                if (text[i] === quote) {
                    if (text[i + 1] === quote) {
                        value += quote;
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                value += text[i++];
            }
            while (i < length && /\s/.test(text[i])) i++;
            if (i < length && text[i] !== ";") {
                throw new Error(
                    `Format of the connection string is not valid: unexpected text after the quoted value of "${key}" (at position ${i + 1}).`,
                );
            }
        } else {
            const valueStart = i;
            while (i < length && text[i] !== ";") i++;
            value = text.slice(valueStart, i).trim();
        }
        pairs.push([key, value]);
    }
    return pairs;
}

function parseBoolean(key: string, value: string): boolean {
    switch (value.trim().toLowerCase()) {
        case "true":
        case "yes":
        case "1":
            return true;
        case "false":
        case "no":
        case "0":
            return false;
        default:
            throw new Error(
                `Invalid value for key '${key}': "${value}" is not a boolean (use true or false).`,
            );
    }
}

function parseEncrypt(value: string): string {
    switch (value.trim().toLowerCase()) {
        case "true":
        case "yes":
        case "mandatory":
            return "Mandatory";
        case "false":
        case "no":
        case "optional":
            return "Optional";
        case "strict":
            return "Strict";
        default:
            throw new Error(
                `Invalid value for key 'Encrypt': "${value}" (use true, false, mandatory, optional or strict).`,
            );
    }
}

export function parseConnectionString(connectionString: string): ConnectionOptionValues {
    const result: ConnectionOptionValues = {};
    let authentication: string | undefined;
    let integrated = false;

    for (const [key, value] of tokenize(connectionString)) {
        const normalized = normalizeKey(key);
        if (normalized === "authentication") {
            if (value === "") continue;
            const mapped = AUTHENTICATION_KEYWORDS[normalizeKey(value)];
            if (!mapped) throw new Error(`Invalid value for key 'Authentication': "${value}".`);
            authentication = mapped;
            continue;
        }
        if (normalized === "integratedsecurity" || normalized === "trustedconnection") {
            if (value === "") continue;
            integrated = value.trim().toLowerCase() === "sspi" ? true : parseBoolean(key, value);
            continue;
        }
        const spec = KEYWORDS[normalized] ?? (normalized === "port" ? PORT_SPEC : undefined);
        if (!spec) continue; // unknown keys are ignored
        if (value === "") continue;

        switch (spec.kind) {
            case "string":
                result[spec.option] = value;
                break;
            case "number": {
                const number = Number(value);
                if (!/^\s*-?\d+\s*$/.test(value) || !Number.isSafeInteger(number)) {
                    throw new Error(
                        `Invalid value for key '${key}': "${value}" is not an integer.`,
                    );
                }
                result[spec.option] = number;
                break;
            }
            case "boolean":
                result[spec.option] = parseBoolean(key, value);
                break;
            case "category": {
                if (spec.option === "encrypt") {
                    result.encrypt = parseEncrypt(value);
                    break;
                }
                const match = spec.values?.find(
                    (candidate) => candidate.toLowerCase() === value.trim().toLowerCase(),
                );
                if (!match)
                    throw new Error(
                        `Invalid value for key '${key}': "${value}" (expected ${spec.values?.join(", ")}).`,
                    );
                result[spec.option] = match;
                break;
            }
        }
    }

    if (
        integrated &&
        authentication !== undefined &&
        authentication !== AuthenticationType.SqlLogin
    ) {
        throw new Error("Cannot use 'Authentication' together with 'Integrated Security'.");
    }
    // With Integrated Security, "User ID" and "Password" are kept: they are the DOMAIN\user and the
    // password of the NTLM sign-in (an ADO.NET client would ignore them).
    result.authenticationType = integrated
        ? "Integrated"
        : (authentication ?? AuthenticationType.SqlLogin);
    return result;
}

/** SqlConnectionStringBuilder quotes values holding separators, quotes, "=" or whitespace. */
function quote(value: string): string {
    return /[;"'=\s]/.test(value) || value === "" ? `"${value.replace(/"/g, '""')}"` : value;
}

function isSet(value: unknown): boolean {
    return value !== undefined && value !== null && value !== "";
}

function formatBoolean(value: unknown): string {
    return value === true || String(value).toLowerCase() === "true" ? "True" : "False";
}

/** Emission order follows sqltoolsservice's getconnectionstring output. */
const BUILD_ORDER: Array<[string, string, OptionKind]> = [
    ["Pooling", "pooling", "boolean"],
    ["Connect Timeout", "connectTimeout", "number"],
    ["Encrypt", "encrypt", "category"],
    ["Host Name In Certificate", "hostNameInCertificate", "string"],
    ["Trust Server Certificate", "trustServerCertificate", "boolean"],
    ["Packet Size", "packetSize", "number"],
    ["AUTHENTICATION", "authenticationType", "string"],
    ["Application Name", "applicationName", "string"],
    ["Current Language", "currentLanguage", "string"],
    ["Workstation ID", "workstationId", "string"],
    ["Application Intent", "applicationIntent", "string"],
    ["Multi Subnet Failover", "multiSubnetFailover", "boolean"],
    ["Command Timeout", "commandTimeout", "number"],
    ["Persist Security Info", "persistSecurityInfo", "boolean"],
    ["Failover Partner", "failoverPartner", "string"],
    ["Min Pool Size", "minPoolSize", "number"],
    ["Max Pool Size", "maxPoolSize", "number"],
    ["Load Balance Timeout", "loadBalanceTimeout", "number"],
    ["Connect Retry Count", "connectRetryCount", "number"],
    ["Connect Retry Interval", "connectRetryInterval", "number"],
    ["Replication", "replication", "boolean"],
    ["Multiple Active Result Sets", "multipleActiveResultSets", "boolean"],
    ["AttachDbFilename", "attachDbFilename", "string"],
    ["Type System Version", "typeSystemVersion", "string"],
    ["Column Encryption Setting", "columnEncryptionSetting", "string"],
    ["Attestation Protocol", "attestationProtocol", "string"],
    ["Enclave Attestation Url", "enclaveAttestationUrl", "string"],
];

export function buildConnectionString(
    options: ConnectionOptionValues,
    includePassword: boolean,
): string {
    const parts: string[] = [];
    const add = (key: string, value: string) => parts.push(`${key}=${quote(value)}`);

    let server = isSet(options.server) ? String(options.server) : "";
    if (server && isSet(options.port) && !server.includes(",")) server += `,${options.port}`;
    if (server) add("Data Source", server);
    if (isSet(options.database)) add("Initial Catalog", String(options.database));

    // Windows Authentication here is NTLM with the account typed by the user, so the user (and the
    // password) are written next to "Integrated Security=True" and read back by the parser. An
    // ADO.NET client would ignore them (it signs in as the current Windows user).
    const integrated = options.authenticationType === "Integrated";
    if (integrated) parts.push("Integrated Security=True");
    if (isSet(options.user)) add("User ID", String(options.user));
    if (includePassword && isSet(options.password)) add("Password", String(options.password));

    for (const [key, name, kind] of BUILD_ORDER) {
        const value = options[name];
        if (!isSet(value)) continue;
        if (key === "AUTHENTICATION") {
            const text = AUTHENTICATION_TEXT[String(value)];
            if (text && !integrated) add("Authentication", text);
        } else if (name === "encrypt") {
            const text = { mandatory: "True", optional: "False", strict: "Strict" }[
                String(value).toLowerCase()
            ];
            if (text) parts.push(`Encrypt=${text}`);
        } else if (kind === "boolean") {
            parts.push(`${key}=${formatBoolean(value)}`);
        } else {
            add(key, String(value));
        }
    }
    return parts.join(";");
}

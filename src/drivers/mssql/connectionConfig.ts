import type { EventEmitter } from "node:events";
import {
    ClientSecretCredential,
    DefaultAzureCredential,
    type TokenCredential,
} from "@azure/identity";
import type { config as SqlConfig } from "mssql";
import type { Connection as TediousConnection } from "tedious";
import { assertEntraServer, sharedCredential } from "../entraCredentials";
import type { AccessTokenProvider, ConnectionOptionValues } from "../types";
import { AuthenticationType } from "../types";
import {
    parseWindowsUserName,
    WINDOWS_AUTHENTICATION_NEEDS_PASSWORD,
} from "./windowsAuthentication";

export const AZURE_SQL_SCOPE = "https://database.windows.net/.default";
/** Names of Azure SQL, Synapse and Fabric servers in the public, US Government and China clouds. */
export const AZURE_SQL_HOST_SUFFIXES = [
    ".database.windows.net",
    ".database.usgovcloudapi.net",
    ".database.chinacloudapi.cn",
    ".sql.azuresynapse.net",
    ".sql.azuresynapse.usgovcloudapi.net",
    ".sql.azuresynapse.chinacloudapi.cn",
    ".database.fabric.microsoft.com",
    ".datawarehouse.fabric.microsoft.com",
];
/**
 * The only audiences an Entra ID token is ever requested for: Azure SQL (which Fabric uses too) and
 * Synapse SQL, in the public, US Government, China and former Germany clouds. The audience is not
 * chosen here: the server announces it during the login. Without this list, a rogue server, or one
 * taking the place of a real server, could ask for a token for another resource of the user (Azure
 * Resource Manager, Microsoft Graph, Key Vault...) and receive it.
 */
export const AZURE_SQL_TOKEN_AUDIENCES = [
    "https://database.windows.net/",
    "https://database.usgovcloudapi.net/",
    "https://database.chinacloudapi.cn/",
    "https://database.cloudapi.de/",
    "https://sql.azuresynapse.net/",
    "https://sql.azuresynapse.usgovcloudapi.net/",
    "https://sql.azuresynapse.chinacloudapi.cn/",
];
const DEFAULT_APPLICATION_NAME = "YetAnotherSqlTool";
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
// The pool must never close its only connection while idle: it carries the session state (USE, SET, #temp tables).
const NEVER_EXPIRE_MS = 2 ** 31 - 1;

export interface ServerAddress {
    host: string;
    port?: number;
    instanceName?: string;
    /** The server as the user sees it, e.g. "localhost,11433". Used in the Object Explorer. */
    displayName: string;
}

/**
 * Understands "host", "host,port", "host\instance" and an optional "tcp:" prefix.
 * The separate `port` option is used when the server text has no port.
 */
export function parseServer(serverText: string, portOption?: number): ServerAddress {
    let text = serverText.trim().replace(/^tcp:/i, "");
    let port = portOption;

    const commaIndex = text.lastIndexOf(",");
    if (commaIndex >= 0) {
        const portFromText = Number(text.slice(commaIndex + 1));
        if (Number.isInteger(portFromText) && portFromText > 0) port = portFromText;
        text = text.slice(0, commaIndex);
    }

    let instanceName: string | undefined;
    const backslashIndex = text.indexOf("\\");
    if (backslashIndex >= 0) {
        instanceName = text.slice(backslashIndex + 1);
        text = text.slice(0, backslashIndex);
    }

    // Keep the text the user typed, only adding the port when it came from the `port` option.
    const typedPortInText = commaIndex >= 0;
    const displayName =
        serverText.trim() + (!typedPortInText && portOption ? `,${portOption}` : "");
    return { host: text, port, instanceName, displayName };
}

function toNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function toBoolean(value: unknown): boolean {
    return value === true || value === "true";
}

/** encrypt option -> tedious: Optional = false, Mandatory = true, Strict = "strict" (TDS 8). */
function toEncryptSetting(value: unknown): boolean | "strict" {
    switch (String(value ?? "Mandatory").toLowerCase()) {
        case "optional":
        case "false":
            return false;
        case "strict":
            return "strict";
        default:
            return true;
    }
}

/**
 * Translates connection options (names from connectionOptions.ts) into an mssql / tedious config.
 * `getAccessToken` is required for AzureMFA authentication; `entraAllowedServers` are the servers,
 * besides Azure's, that may receive an Entra ID token.
 */
export function buildSqlConfig(
    options: ConnectionOptionValues,
    getAccessToken?: AccessTokenProvider,
    entraAllowedServers?: readonly string[],
): SqlConfig {
    const address = parseServer(String(options.server ?? ""), toNumber(options.port));
    const connectTimeoutSeconds =
        toNumber(options.connectTimeout) ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
    const commandTimeoutSeconds =
        toNumber(options.commandTimeout) ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;

    const config: SqlConfig = {
        server: address.host,
        port: address.port,
        database: options.database ? String(options.database) : undefined,
        connectionTimeout: connectTimeoutSeconds * 1000,
        // 0 means "no timeout" in both SQL Server tools and tedious.
        requestTimeout: commandTimeoutSeconds * 1000,
        pool: {
            min: 1,
            max: 1,
            idleTimeoutMillis: NEVER_EXPIRE_MS,
            acquireTimeoutMillis: NEVER_EXPIRE_MS,
        },
        options: {
            instanceName: address.instanceName,
            encrypt: toEncryptSetting(options.encrypt),
            trustServerCertificate: toBoolean(options.trustServerCertificate),
            appName: options.applicationName
                ? String(options.applicationName)
                : DEFAULT_APPLICATION_NAME,
            readOnlyIntent: options.applicationIntent === "ReadOnly",
            multiSubnetFailover: toBoolean(options.multiSubnetFailover),
            serverName: options.hostNameInCertificate
                ? String(options.hostNameInCertificate)
                : undefined,
            packetSize: toNumber(options.packetSize),
            workstationId: options.workstationId ? String(options.workstationId) : undefined,
            language: options.currentLanguage ? String(options.currentLanguage) : undefined,
            // SSMS shows GUIDs in lower case.
            lowerCaseGuids: true,
        } as SqlConfig["options"],
    };

    // For every authentication type: a SQL login's password needs the same care as a token.
    config.beforeConnect = protectLogin;
    if (isEntraAuthentication(options.authenticationType)) {
        assertEntraServer(address.host, AZURE_SQL_HOST_SUFFIXES, entraAllowedServers);
    }
    if (options.authenticationType === AuthenticationType.AzureMFA) {
        if (!getAccessToken)
            throw new Error("Microsoft Entra ID authentication needs an access token provider.");
        // tedious asks the credential on every login, so a pool that reconnects after the
        // token expired gets a fresh one (a fixed "access-token" would fail after an hour).
        config.authentication = {
            type: "token-credential",
            options: { credential: entraCredential(getAccessToken) },
        };
    } else if (options.authenticationType === AuthenticationType.ActiveDirectoryDefault) {
        // The DefaultAzureCredential chain (environment, managed identity, Azure CLI...); the user, if any,
        // picks a user-assigned managed identity.
        const clientId = options.user ? String(options.user) : undefined;
        const credential = sharedCredential(`mssql|default|${clientId ?? ""}`, () =>
            forSqlAudiencesOnly(new DefaultAzureCredential({ managedIdentityClientId: clientId })),
        );
        config.authentication = { type: "token-credential", options: { credential } };
    } else if (options.authenticationType === AuthenticationType.ActiveDirectoryServicePrincipal) {
        // Microsoft's driver reads the tenant from the server's login response; tedious needs it up front.
        if (!options.tenantId)
            throw new Error("The tenant ID is required for service principal authentication.");
        const [tenantId, clientId, secret] = [
            String(options.tenantId),
            String(options.user ?? ""),
            String(options.password ?? ""),
        ];
        const credential = sharedCredential(`mssql|sp|${tenantId}|${clientId}|${secret}`, () =>
            forSqlAudiencesOnly(new ClientSecretCredential(tenantId, clientId, secret)),
        );
        config.authentication = { type: "token-credential", options: { credential } };
    } else if (options.authenticationType === AuthenticationType.Integrated) {
        // NTLM with typed credentials: no token, and no SQL login in the LOGIN7 message.
        const { domain, userName } = parseWindowsUserName(options.user);
        if (options.password === undefined || options.password === null)
            throw new Error(WINDOWS_AUTHENTICATION_NEEDS_PASSWORD);
        config.authentication = {
            type: "ntlm",
            options: { domain, userName, password: String(options.password) },
        };
    } else {
        config.user = options.user ? String(options.user) : undefined;
        config.password = options.password === undefined ? undefined : String(options.password);
    }
    return config;
}

function isEntraAuthentication(authenticationType: unknown): boolean {
    return (
        authenticationType === AuthenticationType.AzureMFA ||
        authenticationType === AuthenticationType.ActiveDirectoryDefault ||
        authenticationType === AuthenticationType.ActiveDirectoryServicePrincipal
    );
}

/**
 * Refuses a token for anything but an Azure SQL database (see AZURE_SQL_TOKEN_AUDIENCES). tedious
 * asks for the scope "<audience announced by the server>/.default".
 */
export function assertSqlTokenScopes(scopes: string | string[]): void {
    for (const scope of [scopes].flat()) {
        if (AZURE_SQL_TOKEN_AUDIENCES.some((audience) => scope === `${audience}.default`)) continue;
        throw new Error(
            `The server asked for a Microsoft Entra ID token for "${scope.replace(/\.default$/, "")}", ` +
                `which is not an Azure SQL database: no token was requested.`,
        );
    }
}

/** The credentials of the machine and of a service principal, limited to Azure SQL audiences. */
function forSqlAudiencesOnly(credential: TokenCredential): TokenCredential {
    return {
        async getToken(scopes, options) {
            assertSqlTokenScopes(scopes);
            return credential.getToken(scopes, options);
        },
    };
}

/**
 * Makes sure neither a password nor a token leaves on a connection that is not encrypted. mssql
 * calls this for every tedious connection it creates, before the connection reaches the server.
 *
 * Client and server agree on encryption in clear text, before TLS. When the answer (the server's,
 * or that of someone in between) is "encryption not supported", tedious carries on without TLS,
 * even with encrypt: true, and sends the login: the user name and a password that is only
 * scrambled, or an Entra ID token. Microsoft's drivers stop there; so does this:
 *   - "Mandatory" (encrypt: true): the login message is not sent without TLS;
 *   - Entra ID, whatever the setting: no token is requested without TLS.
 * "Strict" starts with TLS and needs neither.
 *
 * `sendLogin7Packet` is private to tedious, which is why tedious is pinned to an exact version:
 * test/drivers/mssql/encryption.test.ts fails if an upgrade removes it or stops going through it.
 */
function protectLogin(connection: TediousConnection): void {
    const { authentication, options } = connection.config;
    const usesToken = authentication.type === "token-credential";
    // tedious emits "secure" once TLS is in place.
    const tlsFirst = options.encrypt === "strict";
    let encrypted = tlsFirst;
    connection.on("secure", () => (encrypted = true));
    // Azure SQL's redirection and tedious' retries start over on a new socket, with a new login.
    const events: EventEmitter = connection;
    for (const event of ["rerouting", "retry"]) events.on(event, () => (encrypted = tlsFirst));

    if (options.encrypt === true) {
        const internals = connection as unknown as { sendLogin7Packet?: () => void };
        const sendLogin = internals.sendLogin7Packet;
        if (typeof sendLogin !== "function") {
            // Not the tedious this was written for: better no connection than an unprotected one.
            connection.close();
            throw new Error(
                "Cannot check that the connection is encrypted before logging in: the tedious library is not the " +
                    "version YetAnotherSqlTool was built for. The connection was not attempted.",
            );
        }
        internals.sendLogin7Packet = function (this: unknown) {
            if (!encrypted)
                throw new Error(usesToken ? ENCRYPTION_REQUIRED_FOR_TOKEN : ENCRYPTION_REQUIRED);
            sendLogin.call(this);
        };
    }

    if (authentication.type === "token-credential") {
        const credential = authentication.options.credential;
        authentication.options.credential = {
            async getToken(scopes, tokenOptions) {
                if (!encrypted)
                    throw new Error(
                        "The server did not encrypt the connection: the Microsoft Entra ID token was not sent.",
                    );
                return credential.getToken(scopes, tokenOptions);
            },
        };
    }
}

const ENCRYPTION_REQUIRED =
    "The server does not support encryption, but this connection requires it (Encrypt: Mandatory). " +
    "Nothing was sent: neither the user name nor the password. If this server really has no encryption, " +
    "set Encrypt to Optional in the connection; the user name, the password and the data then travel unprotected.";
const ENCRYPTION_REQUIRED_FOR_TOKEN =
    "The server does not support encryption, but this connection requires it (Encrypt: Mandatory). " +
    "The login was not sent. Microsoft Entra ID authentication only works on an encrypted connection.";

/** An @azure/core-auth TokenCredential backed by the extension's token provider. */
function entraCredential(getAccessToken: AccessTokenProvider) {
    return {
        async getToken(scopes: string | string[]) {
            assertSqlTokenScopes(scopes);
            const scope = Array.isArray(scopes) ? scopes[0] : scopes;
            const token = await getAccessToken(scope ?? AZURE_SQL_SCOPE);
            return { token, expiresOnTimestamp: tokenExpiration(token) };
        },
    };
}

/** Expiry of a JWT access token in milliseconds, or one hour from now when it can't be read. */
export function tokenExpiration(token: string): number {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        if (typeof claims.exp === "number") return claims.exp * 1000;
    } catch {
        // Not a JWT: fall through.
    }
    return Date.now() + 60 * 60 * 1000;
}

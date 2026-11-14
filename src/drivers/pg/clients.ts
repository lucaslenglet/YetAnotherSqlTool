/**
 * Opening pg Clients: option parsing, TLS mapping, Entra ID tokens and readable errors.
 * Used for the query session, the Object Explorer connections and the cancel connection.
 */

import { readFileSync } from "node:fs";
import type { ConnectionOptions as TlsOptions } from "node:tls";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { Client, type ClientConfig } from "pg";
import { assertEntraServer, sharedCredential } from "../entraCredentials";
import type { ConnectionOptionValues, ConnectParams } from "../types";
import { AuthenticationType } from "../types";

const AZURE_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
/** Names of Azure Database for PostgreSQL and Azure Cosmos DB for PostgreSQL servers. */
const AZURE_POSTGRES_HOST_SUFFIXES = [
    ".postgres.database.azure.com",
    ".postgres.database.usgovcloudapi.net",
    ".postgres.database.chinacloudapi.cn",
    ".postgres.cosmos.azure.com",
];

type SslSetting = false | TlsOptions;

export interface ResolvedOptions {
    host: string;
    port: number;
    /** Database used when the profile leaves it empty. */
    database: string;
    user: string;
    password: string;
    applicationName?: string;
    sslMode: string;
    sslRootCert?: string;
    connectTimeoutSeconds: number;
    commandTimeoutSeconds: number;
    searchPath?: string;
    /** Set for Microsoft Entra ID: returns the token used as the password. */
    getEntraToken?: () => Promise<string>;
}

export function resolveOptions(params: ConnectParams): ResolvedOptions {
    const o = params.options;
    const text = (value: unknown) =>
        value === undefined || value === null ? "" : String(value).trim();
    const number = (value: unknown, fallback: number) =>
        text(value) === "" || isNaN(Number(value)) ? fallback : Number(value);

    const host = text(o.server);
    if (!host) throw new Error("The server name is required.");
    const getEntraToken = entraTokenProvider(params);
    if (getEntraToken)
        assertEntraServer(host, AZURE_POSTGRES_HOST_SUFFIXES, params.entraAllowedServers);
    if (
        o.authenticationType === AuthenticationType.ActiveDirectoryServicePrincipal &&
        !text(o.user)
    ) {
        // A service principal's role is named freely (usually after the application): no way to guess it.
        throw new Error(
            "The user name (the PostgreSQL role of the service principal) is required.",
        );
    }
    return {
        host,
        port: number(o.port, 5432),
        database: text(o.database) || "postgres",
        user: text(o.user),
        password: o.password === undefined ? "" : String(o.password),
        applicationName: text(o.applicationName) || undefined,
        // Azure always requires TLS, and a token must never travel in clear text. The modes that
        // also check the server's certificate are kept when the user chose one.
        sslMode:
            getEntraToken && !/^verify-(ca|full)$/.test(text(o.sslmode))
                ? "require"
                : text(o.sslmode) || "prefer",
        sslRootCert: text(o.sslrootcert) || undefined,
        connectTimeoutSeconds: number(o.connectTimeout, 15),
        commandTimeoutSeconds: number(o.commandTimeout, 0),
        searchPath: text(o.searchPath) || undefined,
        getEntraToken,
    };
}

/** How to get a Microsoft Entra ID token for the profile's authentication type, if it uses one. */
function entraTokenProvider(params: ConnectParams): (() => Promise<string>) | undefined {
    const o: ConnectionOptionValues = params.options;
    const text = (value: unknown) =>
        value === undefined || value === null ? "" : String(value).trim();
    switch (o.authenticationType) {
        case AuthenticationType.AzureMFA: {
            const getAccessToken = params.getAccessToken;
            if (!getAccessToken) {
                throw new Error(
                    "Microsoft Entra ID authentication is not available: no access token provider.",
                );
            }
            return () => getAccessToken(AZURE_POSTGRES_SCOPE);
        }
        case AuthenticationType.ActiveDirectoryDefault: {
            const credential = sharedCredential("default|", () => new DefaultAzureCredential());
            return async () => (await credential.getToken(AZURE_POSTGRES_SCOPE)).token;
        }
        case AuthenticationType.ActiveDirectoryServicePrincipal: {
            const [tenantId, clientId, secret] = [
                text(o.tenantId),
                text(o.clientId),
                o.password === undefined ? "" : String(o.password),
            ];
            if (!tenantId)
                throw new Error("The tenant ID is required for service principal authentication.");
            if (!clientId)
                throw new Error(
                    "The Application (Client) ID is required for service principal authentication.",
                );
            const credential = sharedCredential(
                `sp|${tenantId}|${clientId}|${secret}`,
                () => new ClientSecretCredential(tenantId, clientId, secret),
            );
            return async () => (await credential.getToken(AZURE_POSTGRES_SCOPE)).token;
        }
        default:
            return undefined;
    }
}

export const serverAddress = (options: ResolvedOptions) => `${options.host}:${options.port}`;

export const isAzureHost = (host: string) =>
    host.toLowerCase().endsWith(".postgres.database.azure.com");

/**
 * Type parsers that keep PostgreSQL's own text output (so "1.50" stays "1.50", dates
 * are not turned into JS Dates...). Only booleans are rewritten: "t" -> "true".
 */
export const rawTextTypes = {
    getTypeParser: (oid: number) =>
        oid === 16
            ? (value: string) => (value === "t" ? "true" : "false")
            : (value: string) => value,
};

/** TLS settings to try in order, following libpq's sslmode semantics. */
function sslAttemptsFor(options: ResolvedOptions): SslSetting[] {
    const withoutCertificateCheck: TlsOptions = { rejectUnauthorized: false };
    const ca = options.sslRootCert ? readFileSync(options.sslRootCert, "utf8") : undefined;
    switch (options.sslMode) {
        case "disable":
            return [false];
        case "allow":
            return [false, withoutCertificateCheck];
        case "require":
            return [withoutCertificateCheck];
        case "verify-ca":
            // Check the certificate chain but not the host name.
            return [{ rejectUnauthorized: true, ca, checkServerIdentity: () => undefined }];
        case "verify-full":
            return [{ rejectUnauthorized: true, ca }];
        default:
            return [withoutCertificateCheck, false];
    }
}

/** The connection keeps the TLS setting that worked, so later connections do not retry the other one. */
export class ClientFactory {
    private sslAttempts: SslSetting[];
    /** Role of the last attempt: with Microsoft Entra ID it can come from the token instead of the options. */
    private attemptedUser: string | undefined;

    constructor(private readonly options: ResolvedOptions) {
        this.sslAttempts = sslAttemptsFor(options);
    }

    /** Opens a connected Client. `rawText` makes it return every value as PostgreSQL text. */
    async open(database: string, rawText: boolean): Promise<Client> {
        let lastError: unknown;
        for (const ssl of this.sslAttempts) {
            try {
                const client = await this.connectOnce(database, ssl, rawText);
                this.sslAttempts = [ssl];
                return client;
            } catch (error) {
                lastError = error;
                if (!isTlsNegotiationError(error)) break;
            }
        }
        throw new Error(
            describeConnectionError(lastError, {
                ...this.options,
                user: this.attemptedUser ?? this.options.user,
            }),
        );
    }

    private async connectOnce(
        database: string,
        ssl: SslSetting,
        rawText: boolean,
    ): Promise<Client> {
        const o = this.options;
        // A token expires, so every physical connection asks for a fresh one.
        const token = o.getEntraToken ? await o.getEntraToken() : undefined;
        // Azure names an Entra user's role after its sign-in name, e.g. someone@contoso.com.
        const user = o.user || (token && entraUserName(token)) || o.user;
        if (token && !user) {
            // The token of an application or of a managed identity. Without this, pg would send it
            // as the password of the role named after the operating system user.
            throw new Error(
                "The user name is required: this Microsoft Entra ID token does not name a user. " +
                    "Enter the PostgreSQL role of the identity it belongs to.",
            );
        }
        this.attemptedUser = user;
        const config: ClientConfig = {
            host: o.host,
            port: o.port,
            database,
            user,
            password: token ?? o.password,
            application_name: o.applicationName,
            ssl,
            connectionTimeoutMillis: o.connectTimeoutSeconds * 1000,
            statement_timeout:
                o.commandTimeoutSeconds > 0 ? o.commandTimeoutSeconds * 1000 : undefined,
            types: rawText ? rawTextTypes : undefined,
        };
        const client = new Client(config);
        // An idle connection that the server drops emits "error"; without a listener Node would crash.
        client.on("error", () => undefined);
        try {
            await client.connect();
        } catch (error) {
            client.end().catch(() => undefined);
            throw error;
        }
        return client;
    }
}

function isTlsNegotiationError(error: unknown): boolean {
    return /ssl|tls|encryption/i.test(String((error as Error)?.message ?? ""));
}

/** Turns low-level pg / Node errors into a sentence a user can act on. */
export function describeConnectionError(error: unknown, options: ResolvedOptions): string {
    const e = error as NodeJS.ErrnoException;
    const address = serverAddress(options);
    switch (e?.code) {
        case "ECONNREFUSED":
            return `Could not connect to ${address}: connection refused. Is the server running and is the port correct?`;
        case "ENOTFOUND":
            return `Could not connect to ${address}: the host name was not found.`;
        case "ETIMEDOUT":
            return `Could not connect to ${address}: the connection timed out.`;
        case "28P01":
            return `Authentication failed for user "${options.user}": ${e.message}`;
    }
    if (/timeout/i.test(e?.message ?? "")) {
        return `Could not connect to ${address}: no answer after ${options.connectTimeoutSeconds} seconds.`;
    }
    return e?.message ?? String(error);
}

/** Sign-in name (upn, or preferred_username for guests) in an Entra access token. */
export function entraUserName(token: string): string | undefined {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        const name = claims.upn ?? claims.preferred_username ?? claims.unique_name;
        return typeof name === "string" ? name : undefined;
    } catch {
        return undefined;
    }
}

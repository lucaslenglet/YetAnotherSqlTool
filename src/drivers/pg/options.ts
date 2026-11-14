import type { CategoryValue, ConnectionProviderOptions } from "../types";

type OptionSpec = ConnectionProviderOptions["options"][number];

/** Fills the fields every option must have, so the list below only states what differs. */
function option(
    partial: Partial<OptionSpec> &
        Pick<OptionSpec, "name" | "displayName" | "groupName" | "valueType">,
): OptionSpec {
    return {
        specialValueType: null,
        isIdentity: false,
        description: null,
        defaultValue: null,
        objectType: null,
        categoryValues: null,
        isRequired: false,
        isArray: false,
        ...partial,
    };
}

const sslModes: CategoryValue[] = [
    { displayName: "Disable", name: "disable" },
    { displayName: "Allow", name: "allow" },
    { displayName: "Prefer", name: "prefer" },
    { displayName: "Require", name: "require" },
    { displayName: "Verify CA", name: "verify-ca" },
    { displayName: "Verify full", name: "verify-full" },
];

/** Connection dialog description, same shape and group keys as sqltoolsservice's capabilities. */
export function getPgConnectionOptions(): ConnectionProviderOptions {
    return {
        groupDisplayNames: {
            general: "General",
            security: "Security and Encryption",
            resiliency: "Connection Resiliency",
            context: "Data Source & Context",
        },
        options: [
            option({
                specialValueType: "serverName",
                isIdentity: true,
                name: "server",
                displayName: "Server name",
                description: "Host name or IP address of the PostgreSQL server",
                groupName: "general",
                valueType: "string",
                isRequired: true,
            }),
            option({
                name: "port",
                displayName: "Port",
                // No description, as for SQL Server: its (i) icon would wrap the narrow port label.
                groupName: "general",
                valueType: "number",
                defaultValue: "5432",
            }),
            option({
                specialValueType: "databaseName",
                isIdentity: true,
                name: "database",
                displayName: "Database name",
                description: 'The database to connect to. Defaults to "postgres" when empty',
                groupName: "general",
                valueType: "string",
            }),
            option({
                specialValueType: "authType",
                isIdentity: true,
                name: "authenticationType",
                displayName: "Authentication type",
                description: "Specifies the method of authenticating with PostgreSQL",
                groupName: "general",
                valueType: "category",
                categoryValues: [
                    { displayName: "SQL Login", name: "SqlLogin" },
                    {
                        displayName: "Microsoft Entra ID - Universal with MFA support",
                        name: "AzureMFA",
                    },
                    { displayName: "Microsoft Entra ID - Default", name: "ActiveDirectoryDefault" },
                    {
                        displayName: "Microsoft Entra ID - Service Principal",
                        name: "ActiveDirectoryServicePrincipal",
                    },
                ],
                isRequired: true,
            }),
            option({
                specialValueType: "userName",
                isIdentity: true,
                name: "user",
                displayName: "User name",
                description: "The PostgreSQL role used to log in",
                groupName: "general",
                valueType: "string",
                isRequired: true,
            }),
            option({
                // Service principals: the role (user name) is usually the application's display name,
                // so its client ID needs a field of its own (SQL Server takes it as the user name).
                name: "clientId",
                displayName: "Application (Client) ID",
                description: "The Application (Client) ID of your Microsoft Entra app registration",
                groupName: "general",
                valueType: "string",
            }),
            option({
                specialValueType: "password",
                isIdentity: true,
                name: "password",
                displayName: "Password",
                description: "The password of the role",
                groupName: "general",
                valueType: "password",
                isRequired: true,
            }),
            option({
                specialValueType: "appName",
                name: "applicationName",
                displayName: "Application name",
                description:
                    "Name reported to the server (application_name), visible in pg_stat_activity",
                groupName: "general",
                valueType: "string",
            }),
            option({
                name: "sslmode",
                displayName: "SSL mode",
                description:
                    "Whether to use TLS. disable: never. allow/prefer: try one, fall back to the other. " +
                    "require: encrypt without checking the certificate. " +
                    "verify-ca / verify-full: also check the certificate (and the host name for verify-full)",
                groupName: "security",
                valueType: "category",
                categoryValues: sslModes,
                defaultValue: "prefer",
            }),
            option({
                name: "sslrootcert",
                displayName: "SSL root certificate",
                description: "Path to the CA certificate file used by verify-ca and verify-full",
                groupName: "security",
                valueType: "string",
            }),
            option({
                name: "connectTimeout",
                displayName: "Connection timeout (seconds)",
                description:
                    "The length of time (in seconds) to wait for a connection to the server before terminating the attempt",
                groupName: "resiliency",
                valueType: "number",
                defaultValue: "15",
            }),
            option({
                name: "commandTimeout",
                displayName: "Command timeout",
                description:
                    "Maximum duration in seconds of a statement (statement_timeout). 0 means no limit",
                groupName: "resiliency",
                valueType: "number",
                defaultValue: "0",
            }),
            option({
                name: "searchPath",
                displayName: "Search path",
                description:
                    'Value of search_path for the session, e.g. "app, public". Leave empty for the server default',
                groupName: "context",
                valueType: "string",
            }),
        ],
    };
}

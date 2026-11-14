import type { ConnectionProviderOptions } from "../types";
import { AuthenticationType } from "../types";
import { sqlToolsConnectionProvider } from "./connectionOptions.generated";

/** Authentication types this driver can handle (see AuthenticationType in ../types). */
const SUPPORTED_AUTHENTICATION_TYPES: string[] = [
    AuthenticationType.SqlLogin,
    AuthenticationType.Integrated,
    AuthenticationType.AzureMFA,
    AuthenticationType.ActiveDirectoryDefault,
    AuthenticationType.ActiveDirectoryServicePrincipal,
];

/**
 * Connection options shown in the connection dialog: Microsoft's list, unchanged, except that
 * `authenticationType` only offers the methods we implement.
 *
 * Options the driver honors when connecting (see connectionConfig.ts):
 *   server, port, database, authenticationType (SqlLogin, Integrated = NTLM with DOMAIN\user, AzureMFA, ActiveDirectoryDefault,
 *   ActiveDirectoryServicePrincipal), user, password, tenantId (service principal),
 *   encrypt (Optional / Mandatory / Strict), trustServerCertificate, hostNameInCertificate,
 *   connectTimeout, commandTimeout, applicationName, applicationIntent, multiSubnetFailover,
 *   packetSize, workstationId, currentLanguage.
 * All other options are displayed but ignored (column encryption, enclaves, pooling, retry,
 * failover partner, replication, MARS, attachDbFilename, ...).
 */
export function getMssqlConnectionOptions(): ConnectionProviderOptions {
    // Deep copy so callers cannot modify the shared constant.
    const provider: ConnectionProviderOptions = JSON.parse(
        JSON.stringify(sqlToolsConnectionProvider),
    );
    for (const option of provider.options) {
        if (option.name === "authenticationType") {
            option.categoryValues = option.categoryValues.filter((value) =>
                SUPPORTED_AUTHENTICATION_TYPES.includes(value.name),
            );
        }
    }
    return provider;
}

/**
 * Rejects the authentication types this driver does not implement, such as the Entra ID password flow
 * ("ActiveDirectoryPassword"). The dialog does not offer them, but a profile typed in settings.json or imported
 * from a connection string ("Authentication=Active Directory Password") can hold one; without this check the
 * connection would be attempted as a SQL login without user name ("Login failed for user ''").
 * No authentication type means SQL Login, as in Microsoft's extension.
 */
export function assertSupportedAuthenticationType(authenticationType: unknown): void {
    const name =
        authenticationType === undefined || authenticationType === null || authenticationType === ""
            ? AuthenticationType.SqlLogin
            : String(authenticationType);
    if (SUPPORTED_AUTHENTICATION_TYPES.includes(name)) return;

    const values =
        sqlToolsConnectionProvider.options.find((option) => option.name === "authenticationType")
            ?.categoryValues ?? [];
    const displayName = values.find((value) => value.name === name)?.displayName;
    const supported = values
        .filter((value) => SUPPORTED_AUTHENTICATION_TYPES.includes(value.name))
        .map((value) => value.displayName);
    throw new Error(
        `${displayName ? `${displayName} (${name})` : `Authentication type '${name}'`} is not supported yet. ` +
            `Use one of: ${supported.join(", ")}.`,
    );
}

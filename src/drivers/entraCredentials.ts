import type { AccessToken, TokenCredential } from "@azure/identity";

/**
 * Microsoft Entra ID credentials kept for the VS Code session, with their tokens. Drivers ask for
 * a token on every physical connection (each pool, each editor); without this, every login would
 * walk the DefaultAzureCredential chain again (managed identity probe, then a new `az` process),
 * which takes seconds.
 */
const sharedCredentials = new Map<string, TokenCredential>();

export function sharedCredential(key: string, create: () => TokenCredential): TokenCredential {
    let credential = sharedCredentials.get(key);
    if (!credential) {
        credential = withTokenCache(create());
        sharedCredentials.set(key, credential);
    }
    return credential;
}

/** Reuses a token until five minutes before it expires. */
export function withTokenCache(credential: TokenCredential): TokenCredential {
    const tokens = new Map<string, AccessToken>();
    return {
        async getToken(scopes, options) {
            const key = [scopes].flat().join(" ");
            const cached = tokens.get(key);
            if (cached && cached.expiresOnTimestamp - Date.now() > TOKEN_REFRESH_MARGIN_MS)
                return cached;
            const token = await credential.getToken(scopes, options);
            if (token) tokens.set(key, token);
            return token;
        },
    };
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Refuses to send a Microsoft Entra ID token to a server whose name is not Azure's. A token lets
 * whoever receives it act as the user on their Azure databases for about an hour, so a connection
 * pointed elsewhere (a typo, or a profile written by someone else) must not get one.
 * `allowedServers` comes from the user setting `yast.entraId.allowedServers`: exact names, or
 * suffixes when they start with a dot.
 */
export function assertEntraServer(
    host: string,
    azureSuffixes: readonly string[],
    allowedServers: readonly string[] = [],
): void {
    const name = host.trim().toLowerCase().replace(/\.$/, "");
    const matches = (entry: string) => {
        const allowed = entry.trim().toLowerCase();
        return allowed.startsWith(".") ? name.endsWith(allowed) : name === allowed;
    };
    if (name && (azureSuffixes.some(matches) || allowedServers.some(matches))) return;
    throw new Error(
        `Microsoft Entra ID authentication only sends its token to Azure servers (names ending in ` +
            `${azureSuffixes.slice(0, 2).join(", ")}...). To use it with "${host}", add that name ` +
            `to the "yast.entraId.allowedServers" user setting.`,
    );
}

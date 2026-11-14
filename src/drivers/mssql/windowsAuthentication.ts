/**
 * Windows Authentication ("Integrated") through NTLM, with a domain, a user name and a password
 * typed by the user. This is the only form tedious supports: it cannot reuse the current Windows
 * session (SSPI) or speak Kerberos, so Microsoft's "sign in as the current user" is not offered.
 *
 * tedious implements NTLMv2 only (no NTLMv1 fallback, no MIC, no channel binding or extended
 * protection), which SQL Server accepts unless its domain forbids NTLM.
 */

export interface WindowsCredentials {
    /** NetBIOS or DNS domain, as typed; empty for a user principal name (user@domain). */
    domain: string;
    userName: string;
}

export const WINDOWS_AUTHENTICATION_NEEDS_USER =
    "Windows Authentication needs a user name such as DOMAIN\\user and its password: " +
    "signing in with the current Windows session is not supported.";

export const WINDOWS_AUTHENTICATION_NEEDS_PASSWORD =
    "Windows Authentication needs the password of the Windows account: " +
    "signing in with the current Windows session is not supported.";

/** Added to the login failures of a server that is asked for Windows Authentication. */
export const WINDOWS_AUTHENTICATION_HINT =
    "Windows Authentication here uses NTLM with the user name and password entered (DOMAIN\\user). " +
    "Servers that only accept Kerberos, and signing in with the current Windows session, are not supported.";

/**
 * Splits what the user typed into the domain and user name NTLM needs.
 *  - `DOMAIN\user`      -> domain "DOMAIN", user "user"
 *  - `user@domain.com`  -> no domain, user "user@domain.com": MS-NLMP sends a user principal name
 *    whole, with an empty domain, and the server resolves it (NTLMv2 hashes the user name in upper
 *    case followed by the domain, which here is empty).
 * Throws a readable Error for anything else, before any network access.
 */
export function parseWindowsUserName(text: unknown): WindowsCredentials {
    const typed = typeof text === "string" ? text.trim() : "";
    if (!typed) throw new Error(WINDOWS_AUTHENTICATION_NEEDS_USER);

    const backslash = typed.indexOf("\\");
    if (backslash >= 0) {
        const domain = typed.slice(0, backslash).trim();
        const userName = typed.slice(backslash + 1).trim();
        if (!domain || !userName || userName.includes("\\")) throw invalidForm(typed);
        return { domain, userName };
    }

    const at = typed.lastIndexOf("@");
    if (at >= 0) {
        if (at === 0 || at === typed.length - 1) throw invalidForm(typed);
        return { domain: "", userName: typed };
    }
    throw invalidForm(typed);
}

function invalidForm(typed: string): Error {
    return new Error(
        `"${typed}" is not a Windows account name. Windows Authentication expects the domain and ` +
            "the user name, as DOMAIN\\user (or user@domain.com).",
    );
}

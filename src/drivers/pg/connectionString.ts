import type { ConnectionOptionValues } from "../types";

// libpq connection strings: "host=x port=5432 dbname=y ..." and "postgresql://user:pw@host:port/db?param=v".

const SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/** Parsed parameters, keyed by libpq keyword. Later occurrences win. */
type Params = Map<string, string>;

function parseKeywordValue(text: string): Params {
    const params: Params = new Map();
    let i = 0;
    const length = text.length;
    const isSpace = (c: string) => /\s/.test(c);

    while (i < length) {
        while (i < length && isSpace(text[i])) i++;
        if (i >= length) break;

        const keyStart = i;
        while (i < length && text[i] !== "=" && !isSpace(text[i])) i++;
        const key = text.slice(keyStart, i);
        while (i < length && isSpace(text[i])) i++;
        if (i >= length || text[i] !== "=") {
            throw new Error(
                `Invalid connection string: missing "=" after "${key}" (at position ${keyStart + 1}).`,
            );
        }
        if (!key)
            throw new Error(
                `Invalid connection string: a keyword is missing before "=" (at position ${i + 1}).`,
            );
        i++;
        while (i < length && isSpace(text[i])) i++;

        let value = "";
        if (text[i] === "'") {
            const quoteStart = i;
            i++;
            for (;;) {
                if (i >= length)
                    throw new Error(
                        `Invalid connection string: the quoted value of "${key}" is not closed (at position ${quoteStart + 1}).`,
                    );
                const c = text[i];
                if (c === "\\" && i + 1 < length) {
                    value += text[i + 1];
                    i += 2;
                } else if (c === "'") {
                    i++;
                    break;
                } else {
                    value += c;
                    i++;
                }
            }
        } else {
            while (i < length && !isSpace(text[i])) {
                if (text[i] === "\\" && i + 1 < length) {
                    value += text[i + 1];
                    i += 2;
                } else {
                    value += text[i++];
                }
            }
        }
        params.set(key.toLowerCase(), value);
    }
    return params;
}

function decode(part: string, what: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        throw new Error(`Invalid connection string: bad percent-encoding in the ${what}.`);
    }
}

function parseUri(text: string): Params {
    const params: Params = new Map();
    let rest = text.replace(/^postgres(ql)?:\/\//i, "");

    let query = "";
    const queryIndex = rest.indexOf("?");
    if (queryIndex >= 0) {
        query = rest.slice(queryIndex + 1);
        rest = rest.slice(0, queryIndex);
    }
    const slashIndex = rest.indexOf("/");
    let path = "";
    if (slashIndex >= 0) {
        path = rest.slice(slashIndex + 1);
        rest = rest.slice(0, slashIndex);
    }

    const atIndex = rest.lastIndexOf("@");
    if (atIndex >= 0) {
        const userInfo = rest.slice(0, atIndex);
        rest = rest.slice(atIndex + 1);
        const colonIndex = userInfo.indexOf(":");
        const user = decode(
            colonIndex >= 0 ? userInfo.slice(0, colonIndex) : userInfo,
            "user name",
        );
        if (user) params.set("user", user);
        if (colonIndex >= 0)
            params.set("password", decode(userInfo.slice(colonIndex + 1), "password"));
    }

    // Host list: take the first "host:port" entry. IPv6 literals are in brackets.
    const firstHost = splitHostList(rest)[0] ?? "";
    let host = firstHost;
    let port = "";
    if (firstHost.startsWith("[")) {
        const close = firstHost.indexOf("]");
        if (close < 0)
            throw new Error('Invalid connection string: missing "]" in the IPv6 host address.');
        host = firstHost.slice(1, close);
        const after = firstHost.slice(close + 1);
        if (after.startsWith(":")) port = after.slice(1);
        else if (after)
            throw new Error(
                "Invalid connection string: unexpected text after the IPv6 host address.",
            );
    } else {
        const colonIndex = firstHost.lastIndexOf(":");
        if (colonIndex >= 0) {
            host = firstHost.slice(0, colonIndex);
            port = firstHost.slice(colonIndex + 1);
        }
    }
    if (host) params.set("host", decode(host, "host"));
    if (port) params.set("port", port);
    if (path) params.set("dbname", decode(path, "database name"));

    for (const pair of query.split("&")) {
        if (!pair) continue;
        const equalIndex = pair.indexOf("=");
        if (equalIndex <= 0)
            throw new Error(`Invalid connection string: bad query parameter "${pair}".`);
        params.set(
            decode(pair.slice(0, equalIndex), "query").toLowerCase(),
            decode(pair.slice(equalIndex + 1).replace(/\+/g, " "), "query"),
        );
    }
    return params;
}

/** Splits "a:1,b:2" at commas that are outside brackets. */
function splitHostList(text: string): string[] {
    const hosts: string[] = [];
    let depth = 0;
    let current = "";
    for (const c of text) {
        if (c === "[") depth++;
        if (c === "]") depth--;
        if (c === "," && depth === 0) {
            hosts.push(current);
            current = "";
        } else {
            current += c;
        }
    }
    hosts.push(current);
    return hosts;
}

/** Splits a libpq "options" value ("-c a=b --c=d") into words; a backslash escapes the next character. */
function splitOptionWords(text: string): string[] {
    const words: string[] = [];
    let current = "";
    let has = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "\\" && i + 1 < text.length) {
            current += text[++i];
            has = true;
        } else if (/\s/.test(c)) {
            if (has) words.push(current);
            current = "";
            has = false;
        } else {
            current += c;
            has = true;
        }
    }
    if (has) words.push(current);
    return words;
}

/** "5000" or "5s" / "2min" -> seconds; undefined when not understood. */
function statementTimeoutToSeconds(text: string): number | undefined {
    const match = /^\s*(\d+)\s*(us|ms|s|min|h|d)?\s*$/i.exec(text);
    if (!match) return undefined;
    const amount = Number(match[1]);
    const unitMs: Record<string, number> = {
        us: 0.001,
        ms: 1,
        s: 1000,
        min: 60000,
        h: 3600000,
        d: 86400000,
    };
    const milliseconds = amount * unitMs[(match[2] ?? "ms").toLowerCase()];
    return Math.round(milliseconds / 1000);
}

function applyServerOptions(text: string, result: ConnectionOptionValues): void {
    const words = splitOptionWords(text);
    const settings: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word === "-c") settings.push(words[++i] ?? "");
        else if (word.startsWith("-c")) settings.push(word.slice(2));
        else if (word.startsWith("--")) settings.push(word.slice(2));
    }
    for (const setting of settings) {
        const equalIndex = setting.indexOf("=");
        if (equalIndex < 0) continue;
        const name = setting.slice(0, equalIndex).trim().toLowerCase().replace(/-/g, "_");
        const value = setting.slice(equalIndex + 1);
        if (name === "search_path") {
            result.searchPath = value;
        } else if (name === "statement_timeout") {
            const seconds = statementTimeoutToSeconds(value);
            if (seconds !== undefined) result.commandTimeout = seconds;
        }
    }
}

export function parseConnectionString(connectionString: string): ConnectionOptionValues {
    const text = connectionString.trim();
    if (!text) throw new Error("The connection string is empty.");
    const params = /^postgres(ql)?:\/\//i.test(text) ? parseUri(text) : parseKeywordValue(text);

    const result: ConnectionOptionValues = { authenticationType: "SqlLogin" };
    const set = (option: string, ...keywords: string[]) => {
        for (const keyword of keywords.length > 0 ? keywords : [option]) {
            const value = params.get(keyword);
            if (value !== undefined && value !== "") {
                result[option] = value;
                return;
            }
        }
    };
    set("server", "host", "hostaddr");
    set("database", "dbname");
    set("user");
    set("password");
    set("applicationName", "application_name");
    set("sslrootcert");

    // Only the first entry of host / port lists is kept.
    if (result.server !== undefined) result.server = splitHostList(String(result.server))[0];
    const portText = params.get("port")?.split(",")[0].trim();
    if (portText) {
        const port = Number(portText);
        if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
            throw new Error(`Invalid port "${portText}".`);
        result.port = port;
    }
    const sslmode = params.get("sslmode");
    if (sslmode) {
        if (!SSL_MODES.includes(sslmode.toLowerCase())) {
            throw new Error(`Invalid sslmode "${sslmode}" (expected ${SSL_MODES.join(", ")}).`);
        }
        result.sslmode = sslmode.toLowerCase();
    }
    const timeout = params.get("connect_timeout");
    if (timeout) {
        if (!/^\d+$/.test(timeout.trim())) throw new Error(`Invalid connect_timeout "${timeout}".`);
        result.connectTimeout = Number(timeout);
    }
    const serverOptions = params.get("options");
    if (serverOptions) applyServerOptions(serverOptions, result);
    return result;
}

/** Quotes a keyword/value value when it is empty or holds spaces, quotes or backslashes. */
function formatValue(value: string): string {
    if (value !== "" && !/[\s'\\]/.test(value)) return value;
    return `'${value.replace(/[\\']/g, "\\$&")}'`;
}

const isSet = (value: unknown) => value !== undefined && value !== null && value !== "";

export function buildConnectionString(
    options: ConnectionOptionValues,
    includePassword: boolean,
): string {
    const parts: string[] = [];
    const add = (keyword: string, value: unknown) => {
        if (isSet(value)) parts.push(`${keyword}=${formatValue(String(value))}`);
    };
    add("host", options.server);
    add("port", options.port);
    add("dbname", options.database);
    add("user", options.user);
    if (includePassword) add("password", options.password);
    add("sslmode", options.sslmode);
    add("sslrootcert", options.sslrootcert);
    add("application_name", options.applicationName);
    add("connect_timeout", options.connectTimeout);

    const serverSettings: string[] = [];
    // Spaces inside a setting value are backslash-escaped, as libpq requires for "options".
    const escape = (value: string) => value.replace(/[\\\s]/g, "\\$&");
    if (isSet(options.searchPath))
        serverSettings.push(`-c search_path=${escape(String(options.searchPath))}`);
    const commandTimeout = Number(options.commandTimeout);
    if (isSet(options.commandTimeout) && commandTimeout > 0)
        serverSettings.push(`-c statement_timeout=${Math.round(commandTimeout * 1000)}`);
    if (serverSettings.length > 0) add("options", serverSettings.join(" "));
    return parts.join(" ");
}

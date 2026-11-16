/**
 * `${env:NAME}` references in the fields of a connection profile, as in VS Code's launch.json.
 *
 * A profile keeps the text as typed; the values are read from the extension host's environment
 * only when a connection is opened, and live only in the options handed to the driver.
 * `$${env:NAME}` is the escape for the literal text `${env:NAME}`. Anything else (`${foo}`, a
 * lone `$`, `${env:}`) is left as is, so that existing passwords keep working.
 */

import * as vscode from "vscode";
import type { ConnectionOptionValues, DriverConnection } from "../drivers/types";

/** A reference, or its escape when the first group matched. */
const REFERENCE = /(\$?)\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Names of the variables a text references, in order (escaped references excluded). */
export function referencedVariables(text: unknown): string[] {
    if (typeof text !== "string") {
        return [];
    }
    return [...text.matchAll(REFERENCE)].filter((m) => !m[1]).map((m) => m[2]);
}

/** True when the text references at least one environment variable. */
export function hasEnvironmentReferences(text: unknown): boolean {
    return referencedVariables(text).length > 0;
}

/**
 * Replaces the references of a text with the variables' values and unescapes `$${env:NAME}`.
 * Throws, naming the variable, when one is not set; a variable set to "" is a value.
 */
export function resolveEnvironmentReferences(
    text: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return text.replace(REFERENCE, (match: string, escape: string, name: string) => {
        if (escape) {
            return match.slice(1);
        }
        const value = env[name];
        if (value === undefined) {
            throw new Error(vscode.l10n.t("Environment variable {0} is not set", name));
        }
        return value;
    });
}

/** Fields of connection options that reference environment variables, with their text. */
export function environmentReferenceFields(options: ConnectionOptionValues): [string, string][] {
    return Object.entries(options).filter((entry): entry is [string, string] =>
        hasEnvironmentReferences(entry[1]),
    );
}

export interface ResolvedConnectionOptions {
    options: ConnectionOptionValues;
    /**
     * Puts the typed text back in place of the values read from the environment, for error
     * messages (drivers echo the server and user names). Undefined when nothing was read.
     */
    redact?: (text: string) => string;
}

/** Resolves the references of every string option. Throws when a variable is not set. */
export function resolveConnectionOptions(
    options: ConnectionOptionValues,
    env: NodeJS.ProcessEnv = process.env,
): ResolvedConnectionOptions {
    const resolved: ConnectionOptionValues = { ...options };
    // Value read from the environment -> text that stands for it.
    const replacements = new Map<string, string>();
    for (const [key, value] of Object.entries(options)) {
        if (typeof value !== "string" || !value.includes("${env:")) {
            continue;
        }
        resolved[key] = resolveEnvironmentReferences(value, env);
        const names = referencedVariables(value);
        if (names.length === 0) {
            continue;
        }
        replacements.set(String(resolved[key]), value);
        for (const name of names) {
            replacements.set(env[name] ?? "", `\${env:${name}}`);
        }
    }
    replacements.delete("");
    if (replacements.size === 0) {
        return { options: resolved };
    }
    // One pass, longest value first, so that a replacement is never searched again. A short
    // value ("sa") is only replaced as a whole word, not inside every word that contains it.
    const pattern = new RegExp(
        [...replacements.keys()]
            .sort((a, b) => b.length - a.length)
            .map((value) => {
                const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return value.length < 4 ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
            })
            .join("|"),
        "g",
    );
    return {
        options: resolved,
        redact: (text) => text.replace(pattern, (value) => replacements.get(value) ?? ""),
    };
}

/** The error with the values read from the environment put back as typed. */
export function redactError(error: unknown, redact: (text: string) => string): unknown {
    if (error instanceof Error) {
        error.message = redact(error.message);
        if (error.stack) {
            error.stack = redact(error.stack);
        }
        if (error.cause !== undefined) {
            error.cause = redactError(error.cause, redact);
        }
        if (error instanceof AggregateError) {
            error.errors = error.errors.map((inner: unknown) => redactError(inner, redact));
        }
        return error;
    }
    return typeof error === "string" ? redact(error) : error;
}

/** A connection whose failures never show a value read from the environment. */
export function redactConnectionErrors(
    connection: DriverConnection,
    redact: (text: string) => string,
): DriverConnection {
    return new Proxy(connection, {
        get(target, property) {
            const member: unknown = Reflect.get(target, property, target);
            if (typeof member !== "function") {
                return member;
            }
            return (...args: unknown[]) => {
                try {
                    const result: unknown = member.apply(target, args);
                    return result instanceof Promise
                        ? result.catch((error: unknown) => {
                              throw redactError(error, redact);
                          })
                        : result;
                } catch (error) {
                    throw redactError(error, redact);
                }
            };
        },
    });
}

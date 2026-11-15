/**
 * Color of a connection profile (`color`): shown in the status bar and along the SQL editors
 * that use the connection, like SSMS's colored status bar (red for production...).
 *
 * The color is set per profile, without inheritance from its group. An editor keeps a snapshot
 * of the profile it connected with; the color is read from the saved profile with the same id
 * so that a color changed afterwards applies without reconnecting.
 */

import type { IConnectionProfile } from "../models/interfaces";

const colorPattern = /^#[0-9a-f]{6}$/i;

/** The color as `#rrggbb`; undefined when the value is not `#` followed by 6 hex digits. */
export function parseConnectionColor(value: unknown): string | undefined {
    return typeof value === "string" && colorPattern.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Color of a connection made with `profile`: the one of the saved profile with the same id
 * (even when it has none), else the one of `profile` itself.
 */
export function resolveConnectionColor(
    profile: Pick<IConnectionProfile, "id" | "color">,
    savedProfiles: readonly Pick<IConnectionProfile, "id" | "color">[],
): string | undefined {
    const saved = profile.id ? savedProfiles.find((p) => p.id === profile.id) : undefined;
    return parseConnectionColor(saved ? saved.color : profile.color);
}

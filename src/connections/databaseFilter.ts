/**
 * Database filter of a connection profile (`databaseFilter`): the databases the Object
 * Explorer and the "change database" list show for that connection.
 *
 * The filter is a list of patterns separated by `;` or `,`. `*` stands for any text and
 * `?` for one character; a pattern starting with `!` hides the databases it matches.
 * A database is shown when it matches one of the patterns (or when there are only `!`
 * patterns) and none of the `!` patterns. Case is ignored.
 */

export type DatabaseFilter = (database: string) => boolean;

/** The filter of a profile; undefined when the profile shows every database. */
export function createDatabaseFilter(filter: string | undefined): DatabaseFilter | undefined {
    const include: RegExp[] = [];
    const exclude: RegExp[] = [];
    for (const part of (filter ?? "").split(/[;,]/)) {
        const pattern = part.trim();
        if (pattern.startsWith("!")) {
            if (pattern.length > 1) {
                exclude.push(toRegExp(pattern.slice(1).trim()));
            }
        } else if (pattern) {
            include.push(toRegExp(pattern));
        }
    }
    if (include.length === 0 && exclude.length === 0) {
        return undefined;
    }
    return (database) =>
        (include.length === 0 || include.some((p) => p.test(database))) &&
        !exclude.some((p) => p.test(database));
}

function toRegExp(pattern: string): RegExp {
    const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${source}$`, "is");
}

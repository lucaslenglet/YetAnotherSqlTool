// Dev tool: regenerates the vocabulary of each engine's SQL dialect (keywords, data types and
// built-in functions), used by syntax highlighting and later by autocompletion:
//   src/drivers/pg/language.generated.ts     from a real PostgreSQL: pg_get_keywords(), pg_type, pg_proc
//   src/drivers/mssql/language.generated.ts  from a real SQL Server (sys.types) and from the word
//                                            lists of Microsoft's T-SQL grammar (SQL.plist)
// Hand-written additions and exclusions live next to them, in language.ts.
//
// Usage: node tools/gen-sql-language.mjs [path/to/SQL.plist]
//   Needs Docker: starts the test databases of test/support/containers.mjs (random ports) and
//   removes them at the end. SQL.plist defaults to ../_reference/vscode-mssql (see CLAUDE.md).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, MSSQL_IMAGE, startDatabases } from "../test/support/containers.mjs";

const require = createRequire(import.meta.url);
const pg = require("pg");
const mssql = require("mssql");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const grammarPath =
    process.argv[2] ??
    path.join(homedir(), "Dev/_reference/vscode-mssql/extensions/mssql/syntaxes/SQL.plist");

// ---------------------------------------------------------------------------------------------
// Microsoft's T-SQL grammar
// ---------------------------------------------------------------------------------------------

/** Minimal property list reader: dict, array, key, string, integer, true and false. */
function parsePlist(xml) {
    const tokens = [
        ...xml.matchAll(/<(\/?)(dict|array|key|string|integer|true|false)(\/?)>|([^<]+)/g),
    ];
    let i = 0;
    const decode = (s) =>
        s
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&");
    const text = () => {
        let value = "";
        while (tokens[i][4] !== undefined) value += tokens[i++][4];
        i++; // closing tag
        return decode(value);
    };
    function value() {
        while (tokens[i][4] !== undefined) i++; // whitespace
        const [, closing, tag, selfClosing] = tokens[i++];
        if (closing) throw new Error(`unexpected </${tag}>`);
        if (tag === "true" || tag === "false") return tag === "true";
        if (selfClosing) return tag === "dict" ? {} : tag === "array" ? [] : "";
        if (tag === "string" || tag === "key") return text();
        if (tag === "integer") return Number(text());
        const result = tag === "dict" ? {} : [];
        for (;;) {
            while (tokens[i][4] !== undefined) i++;
            if (tokens[i][1]) {
                i++;
                return result;
            }
            if (tag === "dict") {
                i++; // <key>
                const key = text();
                result[key] = value();
            } else {
                result.push(value());
            }
        }
    }
    while (tokens[i][2] !== "dict") i++;
    return value();
}

/**
 * The strings matched by a regex made of alternations, groups and optional parts, which is how
 * the grammar writes its word lists: "current_time(stamp)?" gives current_time and
 * current_timestamp. Whitespace classes become one space; \b, \d and lookarounds match nothing.
 */
function expandRegex(src) {
    let i = 0;
    function alternation() {
        const alternatives = [sequence()];
        while (src[i] === "|") {
            i++;
            alternatives.push(sequence());
        }
        return alternatives.flat();
    }
    function sequence() {
        let results = [""];
        while (i < src.length && src[i] !== "|" && src[i] !== ")") {
            let atom;
            const flags = /^\(\?[a-z]+\)/.exec(src.slice(i));
            if (flags) {
                i += flags[0].length;
                continue;
            }
            if (/^\(\?(<!|<=|=|!)/.test(src.slice(i))) {
                for (let depth = 0; ;) {
                    if (src[i] === "\\") i++;
                    else if (src[i] === "(") depth++;
                    else if (src[i] === ")" && --depth === 0) break;
                    i++;
                }
                i++;
                continue;
            }
            if (src[i] === "(") {
                const opener = /^\((\?[a-z]*:)?/.exec(src.slice(i))[0];
                i += opener.length;
                atom = alternation();
                i++; // )
            } else if (src[i] === "\\") {
                const c = src[i + 1];
                i += 2;
                atom = c === "s" ? [" "] : c === "b" || c === "d" ? [""] : [c];
            } else if (src[i] === "[") {
                i = src.indexOf("]", i + 1) + 1;
                atom = [""];
            } else {
                atom = [src[i++]];
            }
            let optional = false;
            while (i < src.length && "?+*".includes(src[i])) {
                if (src[i] !== "+") optional = true;
                i++;
            }
            if (optional) atom = ["", ...atom];
            results = results.flatMap((r) => atom.map((a) => r + a));
        }
        return results;
    }
    return alternation();
}

/** Upper-case words of the grammar's patterns, by scope name. */
function grammarWords(grammar) {
    const byScope = new Map();
    for (const pattern of grammar.patterns) {
        const scope = pattern.name ?? pattern.captures?.["1"]?.name;
        if (!scope || !pattern.match) continue;
        // Extended-mode comments and spacing; the "(" that ends function patterns.
        const source = pattern.match
            .replace(/#[^\n]*\n/g, "")
            .replace(/\s+/g, "")
            .replace(/\\s\*\\\($/, "");
        const words = byScope.get(scope) ?? new Set();
        for (const phrase of expandRegex(source)) {
            for (const word of phrase.trim().split(/\s+/)) {
                if (/^@{0,2}[A-Za-z_][A-Za-z0-9_]*$/.test(word)) words.add(word.toUpperCase());
            }
        }
        byScope.set(scope, words);
    }
    return byScope;
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------------

/**
 * Types that users write: base, range, multirange, and the pseudo-types of function definitions
 * (RETURNS void, trigger, record...); not arrays or internal ones. "any" is left out: it is
 * written with quotes, and ANY unquoted is a keyword.
 */
const PG_TYPES = `
    select t.typname, format_type(t.oid, null) as formatted, t.typcategory
    from pg_type t
    where t.typnamespace = 'pg_catalog'::regnamespace
      and t.typtype in ('b', 'r', 'm', 'p')
      and t.typcategory not in ('A', 'Z')
      and t.typname not like '\\_%'
      and t.typname <> 'any'`;

/**
 * Functions users call. Left out: those that implement an operator, a type's I/O, an aggregate's
 * steps, an index method or a selectivity estimate, and those taking or returning "internal" or
 * a handler pseudo-type: none of them is meant to be called by name.
 */
const PG_FUNCTIONS = `
    select distinct p.proname
    from pg_proc p
    where p.pronamespace = 'pg_catalog'::regnamespace
      and p.prokind in ('f', 'a', 'w')
      and p.prorettype::regtype::text not in ('internal', 'trigger', 'event_trigger',
          'language_handler', 'fdw_handler', 'index_am_handler', 'table_am_handler', 'tsm_handler')
      and not 'internal'::regtype = any (p.proargtypes)
      and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'implementation of%'
      and coalesce(obj_description(p.oid, 'pg_proc'), '') not in ('I/O')
      and coalesce(obj_description(p.oid, 'pg_proc'), '') !~* '^(deprecated|internal)'
      and not exists (select 1 from pg_operator o where p.oid in (o.oprcode, o.oprrest, o.oprjoin))
      and not exists (select 1 from pg_type t where p.oid in (t.typinput, t.typoutput,
          t.typreceive, t.typsend, t.typmodin, t.typmodout, t.typanalyze, t.typsubscript))
      and not exists (select 1 from pg_aggregate a where p.oid in (a.aggtransfn, a.aggfinalfn,
          a.aggcombinefn, a.aggserialfn, a.aggdeserialfn, a.aggmtransfn, a.aggminvtransfn,
          a.aggmfinalfn))
      and not exists (select 1 from pg_amproc a where a.amproc = p.oid)
    order by 1`;

/** Internal helpers that pass the filters above but are not documented for users. */
const PG_FUNCTION_EXCLUDED =
    /^(binary_upgrade_|pg_stat_get_|fmgr_)|_(validator|canonical|subdiff)$|^(currtid2|int4inc|int8_sum|numeric_(div_trunc|exp|inc|ln|log|sqrt)|dexp|dlog1|dlog10|dround|dtrunc|pg_isolation_test_session_is_blocked|pg_stop_making_pinned_objects|pg_nextoid|amvalidate|nameconcatoid|like|notlike|like_escape|similar_escape|similar_to_escape|textlen|satisfies_hash_partition)$/;

async function readPostgres(info) {
    const client = new pg.Client(info);
    await client.connect();
    try {
        const query = async (sql) => (await client.query(sql)).rows;
        const version = (await query("show server_version"))[0].server_version;
        const keywords = await query("select upper(word) as word, catcode from pg_get_keywords()");
        const types = await query(PG_TYPES);
        const typeNames = new Set(types.flatMap((t) => [t.typname, t.formatted]));
        // Casts named after their type (int4(x), text(x)) are types for the user, except the
        // constructors of ranges and geometric values, which are called as functions.
        const constructors = new Set(
            types.filter((t) => "RG".includes(t.typcategory)).map((t) => t.typname),
        );
        const functions = (await query(PG_FUNCTIONS))
            .map((row) => row.proname)
            .filter((name) => !PG_FUNCTION_EXCLUDED.test(name))
            .filter((name) => !typeNames.has(name) || constructors.has(name));
        return {
            version,
            reserved: keywords.filter((k) => "RT".includes(k.catcode)).map((k) => k.word),
            unreserved: keywords.filter((k) => "UC".includes(k.catcode)).map((k) => k.word),
            types: [...typeNames].map((t) => t.toUpperCase()),
            functions: functions.map((f) => f.toUpperCase()),
        };
    } finally {
        await client.end();
    }
}

// ---------------------------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------------------------

async function readMssql(info) {
    const pool = await new mssql.ConnectionPool({
        server: info.host,
        port: info.port,
        user: info.user,
        password: info.password,
        database: "master",
        options: { encrypt: true, trustServerCertificate: true },
    }).connect();
    try {
        const version = (await pool.request().query("select serverproperty('ProductVersion') v"))
            .recordset[0].v;
        const types = (
            await pool.request().query("select name from sys.types where is_user_defined = 0")
        ).recordset.map((row) => row.name.toUpperCase());
        return { version, types };
    } finally {
        await pool.close();
    }
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/**
 * A sorted word list as a template literal wrapped at 100 columns, read by `words()`. Phrases
 * of several words (DOUBLE PRECISION) are written with "+" between their words.
 */
function wordList(name, doc, list) {
    const sorted = [...new Set(list.map((word) => word.replace(/ /g, "+")))].sort();
    const lines = [];
    let line = "   ";
    for (const word of sorted) {
        if (line.length + word.length + 1 > 100) {
            lines.push(line);
            line = "   ";
        }
        line += ` ${word}`;
    }
    lines.push(line);
    return `/** ${doc} (${sorted.length}) */\nexport const ${name} = words(\`\n${lines.join("\n")}\n\`);\n`;
}

function writeGenerated(file, source, lists) {
    const header = [
        `// Generated by tools/gen-sql-language.mjs from ${source}. Do not edit:`,
        "// run the tool again, or add words in language.ts.",
        "",
        "const words = (list: string): readonly string[] =>",
        '    list.trim().split(/\\s+/).map((word) => word.replace(/\\+/g, " "));',
        "",
    ].join("\n");
    writeFileSync(path.join(root, file), header + "\n" + lists.join("\n"));
    console.log(`Wrote ${file}`);
}

const grammar = grammarWords(parsePlist(readFileSync(grammarPath, "utf8")));
const scopeWords = (test) =>
    [...grammar.entries()].filter(([scope]) => test(scope)).flatMap(([, words]) => [...words]);

console.log("Starting the test databases...");
const databases = await startDatabases();
try {
    const [pgInfo, mssqlInfo] = await Promise.all([
        readPostgres(databases.pg),
        readMssql(databases.mssql),
    ]);

    writeGenerated(
        "src/drivers/pg/language.generated.ts",
        `PostgreSQL ${pgInfo.version} (${POSTGRES_IMAGE})`,
        [
            wordList(
                "pgReservedKeywords",
                "pg_get_keywords(): reserved, and reserved that can be a function or type name",
                pgInfo.reserved,
            ),
            wordList(
                "pgUnreservedKeywords",
                "pg_get_keywords(): unreserved, and unreserved that cannot be a function or type name",
                pgInfo.unreserved,
            ),
            wordList("pgDataTypes", "pg_type: names and SQL names (format_type)", pgInfo.types),
            wordList(
                "pgFunctions",
                "pg_proc: functions, aggregates and window functions",
                pgInfo.functions,
            ),
        ],
    );

    const functionScopes = (scope) =>
        scope.startsWith("support.function.") && scope !== "support.function.globalvar.sql";
    writeGenerated(
        "src/drivers/mssql/language.generated.ts",
        `SQL Server ${mssqlInfo.version} (${MSSQL_IMAGE}) and vscode-mssql's syntaxes/SQL.plist`,
        [
            wordList(
                "grammarKeywords",
                "SQL.plist: words of the keyword.other.*.sql and storage.modifier.sql patterns",
                scopeWords(
                    (scope) =>
                        (scope.startsWith("keyword.other.") &&
                            scope !== "keyword.other.object-comments.sql") ||
                        scope === "storage.modifier.sql",
                ),
            ),
            wordList(
                "grammarFunctions",
                "SQL.plist: words of the support.function.*.sql patterns",
                scopeWords(functionScopes),
            ),
            wordList(
                "grammarGlobalVariables",
                "SQL.plist: words of the support.function.globalvar.sql pattern",
                scopeWords((scope) => scope === "support.function.globalvar.sql"),
            ),
            wordList("mssqlSystemTypes", "sys.types where is_user_defined = 0", mssqlInfo.types),
        ],
    );
} finally {
    await databases.stop();
}

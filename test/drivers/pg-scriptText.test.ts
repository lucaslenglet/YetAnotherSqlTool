import { describe, expect, it } from "vitest";
import { dependencyOrder } from "../../src/drivers/pg/scriptDatabase";
import * as text from "../../src/drivers/pg/scriptText";

// The PostgreSQL scripts from catalog rows, without a database
// (test/drivers/pg-scriptObjects.integration.test.ts runs them on a real server).

const column = (name: string, type: string, extra: Partial<text.PgColumn> = {}): text.PgColumn => ({
    name,
    type,
    collation: null,
    notNull: false,
    defaultExpression: null,
    identity: "",
    identitySequence: null,
    generatedExpression: null,
    comment: null,
    ...extra,
});

const sequence = (
    qualifiedName: string,
    extra: Partial<text.PgSequence> = {},
): text.PgSequence => ({
    qualifiedName,
    type: "bigint",
    start: "1",
    increment: "1",
    min: "1",
    max: "9223372036854775807",
    cache: "1",
    cycle: false,
    ownedBy: null,
    comment: null,
    ...extra,
});

const table = (extra: Partial<text.PgTable> = {}): text.PgTable => ({
    qualifiedName: "s.t",
    kind: "r",
    unlogged: false,
    partitionKey: null,
    partitionOf: null,
    partitionBound: null,
    options: [],
    rowSecurity: false,
    forceRowSecurity: false,
    comment: null,
    columns: [column("id", "integer", { notNull: true })],
    constraints: [],
    indexes: [],
    triggers: [],
    ownedSequences: [],
    partitions: [],
    ...extra,
});

describe("PostgreSQL table scripts", () => {
    it("writes columns, inline checks, keys after the table, and comments", () => {
        const t = table({
            unlogged: true,
            options: ["fillfactor=70"],
            comment: "'A table'",
            columns: [
                column("id", "integer", {
                    notNull: true,
                    identity: "a",
                    identitySequence: sequence("s.t_id_seq", {
                        type: "integer",
                        max: "2147483647",
                    }),
                }),
                column('"Name"', "text", {
                    collation: 'pg_catalog."C"',
                    defaultExpression: "'x'::text",
                    comment: "'it''s'",
                }),
                column("twice", "integer", { generatedExpression: "(id * 2)" }),
            ],
            constraints: [
                {
                    name: "t_pkey",
                    type: "p",
                    definition: "PRIMARY KEY (id)",
                    validated: true,
                    comment: null,
                },
                {
                    name: "ok",
                    type: "c",
                    definition: "CHECK ((id > 0))",
                    validated: true,
                    comment: null,
                },
                {
                    name: "late",
                    type: "c",
                    definition: "CHECK ((id < 9)) NOT VALID",
                    validated: false,
                    comment: null,
                },
                {
                    name: "fk",
                    type: "f",
                    definition: "FOREIGN KEY (id) REFERENCES s.p(id)",
                    validated: true,
                    comment: null,
                },
            ],
            indexes: [
                {
                    qualifiedName: "s.t_pkey",
                    name: "t_pkey",
                    definition: "CREATE UNIQUE INDEX t_pkey ON s.t USING btree (id)",
                    constraintName: "t_pkey",
                    comment: null,
                },
                {
                    qualifiedName: "s.ix",
                    name: "ix",
                    definition: "CREATE INDEX ix ON s.t USING btree (twice)",
                    constraintName: null,
                    comment: null,
                },
            ],
            triggers: [
                {
                    name: "tg",
                    definition:
                        "CREATE TRIGGER tg BEFORE INSERT ON s.t FOR EACH ROW EXECUTE FUNCTION s.f()",
                    enabled: "D",
                    comment: null,
                },
            ],
        });
        expect(text.scriptTableCreate(t)).toBe(`CREATE UNLOGGED TABLE s.t (
    id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME s.t_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1) NOT NULL,
    "Name" text COLLATE pg_catalog."C" DEFAULT 'x'::text,
    twice integer GENERATED ALWAYS AS ((id * 2)) STORED,
    CONSTRAINT ok CHECK ((id > 0))
)
WITH (fillfactor=70);

ALTER TABLE ONLY s.t
    ADD CONSTRAINT t_pkey PRIMARY KEY (id);

COMMENT ON TABLE s.t IS 'A table';

COMMENT ON COLUMN s.t."Name" IS 'it''s';

ALTER TABLE ONLY s.t
    ADD CONSTRAINT late CHECK ((id < 9)) NOT VALID;

ALTER TABLE ONLY s.t
    ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES s.p(id);

CREATE INDEX ix ON s.t USING btree (twice);

CREATE TRIGGER tg BEFORE INSERT ON s.t FOR EACH ROW EXECUTE FUNCTION s.f();

ALTER TABLE s.t DISABLE TRIGGER tg;
`);
        expect(text.scriptTableDrop(t)).toBe("DROP TABLE IF EXISTS s.t;\n");
    });

    it("creates serial sequences before the table and gives them their owner after it", () => {
        const owned = sequence("s.t_id_seq", {
            type: "integer",
            max: "2147483647",
            ownedBy: "s.t.id",
        });
        const t = table({
            columns: [
                column("id", "integer", {
                    notNull: true,
                    defaultExpression: "nextval('s.t_id_seq'::regclass)",
                }),
            ],
            ownedSequences: [owned],
        });
        expect(text.scriptTableCreate(t)).toBe(`CREATE SEQUENCE s.t_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE s.t (
    id integer DEFAULT nextval('s.t_id_seq'::regclass) NOT NULL
);

ALTER SEQUENCE s.t_id_seq OWNED BY s.t.id;
`);
    });

    it("writes partitions after their partitioned table, and its indexes without ONLY", () => {
        const t = table({
            kind: "p",
            partitionKey: "RANGE (d)",
            indexes: [
                {
                    qualifiedName: "s.ix",
                    name: "ix",
                    definition: "CREATE INDEX ix ON ONLY s.t USING btree (id)",
                    constraintName: null,
                    comment: null,
                },
            ],
            partitions: [
                table({
                    qualifiedName: "s.t_2024",
                    partitionOf: "s.t",
                    partitionBound: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
                }),
            ],
        });
        const script = text.scriptTableCreate(t);
        expect(script).toContain(
            "CREATE TABLE s.t (\n    id integer NOT NULL\n)\nPARTITION BY RANGE (d);",
        );
        expect(script).toContain(
            "CREATE TABLE s.t_2024 PARTITION OF s.t\nFOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
        );
        expect(script).toContain("CREATE INDEX ix ON s.t USING btree (id);");
    });
});

describe("PostgreSQL sequence, view, routine and type scripts", () => {
    it("writes NO MINVALUE / NO MAXVALUE for the defaults of the direction", () => {
        expect(
            text.scriptSequenceCreate(
                sequence("s.down", {
                    increment: "-1",
                    start: "-1",
                    min: "-9223372036854775808",
                    max: "-1",
                }),
            ),
        ).toBe(
            "CREATE SEQUENCE s.down\n    START WITH -1\n    INCREMENT BY -1\n    NO MINVALUE\n    NO MAXVALUE\n    CACHE 1;\n",
        );
        expect(
            text.scriptSequenceCreate(
                sequence("s.c", {
                    type: "smallint",
                    min: "5",
                    max: "500",
                    cycle: true,
                    cache: "2",
                }),
            ),
        ).toBe(
            "CREATE SEQUENCE s.c\n    AS smallint\n    START WITH 1\n    INCREMENT BY 1\n    MINVALUE 5\n    MAXVALUE 500\n    CACHE 2\n    CYCLE;\n",
        );
    });

    const view: text.PgView = {
        qualifiedName: "s.v",
        materialized: false,
        definition: " SELECT id\n   FROM s.t;",
        options: ["security_barrier=true"],
        checkOption: "local",
        populated: true,
        comment: null,
        columnComments: [],
        indexes: [],
        triggers: [],
    };

    it("writes views, with CREATE OR REPLACE for Alter", () => {
        expect(text.scriptViewCreate(view)).toBe(
            "CREATE VIEW s.v WITH (security_barrier=true) AS\n SELECT id\n   FROM s.t\n  WITH LOCAL CHECK OPTION;\n",
        );
        expect(text.scriptViewAlter(view)).toMatch(/^CREATE OR REPLACE VIEW s\.v /);
        expect(text.scriptViewDrop(view)).toBe("DROP VIEW IF EXISTS s.v;\n");
    });

    it("drops and creates a materialized view for Alter", () => {
        const matview = { ...view, materialized: true, options: [], checkOption: null };
        expect(text.scriptViewAlter(matview)).toBe(
            "-- A materialized view cannot be replaced: it is dropped and created again, with its indexes.\n" +
                "DROP MATERIALIZED VIEW IF EXISTS s.v;\n\nCREATE MATERIALIZED VIEW s.v AS\n SELECT id\n   FROM s.t\n  WITH DATA;\n",
        );
    });

    const procedure: text.PgRoutine = {
        qualifiedName: "s.p",
        identityArguments: "IN a integer, INOUT b text",
        isProcedure: true,
        definition:
            "CREATE OR REPLACE PROCEDURE s.p(IN a integer, INOUT b text)\n LANGUAGE sql\nAS $procedure$ SELECT 1 $procedure$\n",
        arguments: [
            { name: "a", mode: "i", type: "integer" },
            { name: "b", mode: "b", type: "text" },
            { name: "", mode: "v", type: "integer[]" },
        ],
        comment: "'Does it'",
    };

    it("writes routines from pg_get_functiondef", () => {
        expect(text.scriptRoutineCreate(procedure)).toBe(
            "CREATE PROCEDURE s.p(IN a integer, INOUT b text)\n LANGUAGE sql\nAS $procedure$ SELECT 1 $procedure$;\n\nCOMMENT ON PROCEDURE s.p(IN a integer, INOUT b text) IS 'Does it';\n",
        );
        expect(text.scriptRoutineAlter(procedure)).toMatch(/^CREATE OR REPLACE PROCEDURE/);
        expect(text.scriptRoutineDrop(procedure)).toBe(
            "DROP PROCEDURE IF EXISTS s.p(IN a integer, INOUT b text);\n",
        );
    });

    it("lists every argument with a NULL of its type in the Execute script", () => {
        expect(text.scriptProcedureExecute(procedure)).toBe(
            "-- TODO: Set parameter values here.\n\nCALL s.p(\n    a => NULL::integer,\n    b => NULL::text,\n    VARIADIC NULL::integer[]\n);\n",
        );
        expect(text.scriptProcedureExecute({ ...procedure, arguments: [] })).toBe(
            "-- TODO: Set parameter values here.\n\nCALL s.p();\n",
        );
    });

    const type = (extra: Partial<text.PgType>): text.PgType => ({
        qualifiedName: "s.ty",
        kind: "e",
        baseType: null,
        collation: null,
        notNull: false,
        defaultExpression: null,
        constraints: [],
        labels: [],
        attributes: [],
        rangeOptions: [],
        comment: null,
        ...extra,
    });

    it("writes domains, enums, composite and range types", () => {
        expect(
            text.scriptTypeCreate(
                type({
                    kind: "d",
                    baseType: "integer",
                    notNull: true,
                    defaultExpression: "1",
                    constraints: [["positive", "CHECK ((VALUE > 0))"]],
                }),
            ),
        ).toBe(
            "CREATE DOMAIN s.ty AS integer DEFAULT 1 NOT NULL\n\tCONSTRAINT positive CHECK ((VALUE > 0));\n",
        );
        expect(text.scriptTypeCreate(type({ labels: ["'a'", "'b'"] }))).toBe(
            "CREATE TYPE s.ty AS ENUM (\n    'a',\n    'b'\n);\n",
        );
        expect(
            text.scriptTypeCreate(
                type({ kind: "c", attributes: [{ name: "a", type: "integer", collation: null }] }),
            ),
        ).toBe("CREATE TYPE s.ty AS (\n    a integer\n);\n");
        expect(
            text.scriptTypeCreate(
                type({
                    kind: "r",
                    baseType: "double precision",
                    rangeOptions: ["subtype_diff = float8mi"],
                }),
            ),
        ).toBe(
            "CREATE TYPE s.ty AS RANGE (\n    subtype = double precision,\n    subtype_diff = float8mi\n);\n",
        );
        expect(text.scriptTypeDrop(type({ kind: "d" }))).toBe("DROP DOMAIN IF EXISTS s.ty;\n");
    });
});

describe("PostgreSQL database script order", () => {
    const item = (kind: "type" | "table" | "view" | "routine", key: string, name: string) =>
        ({ kind, key, name }) as never;

    it("puts each object after what it depends on, then by kind and name", () => {
        const order = dependencyOrder(
            [
                item("view", "c3", "s.v"),
                item("table", "c1", "s.b"),
                item("table", "c2", "s.a"),
                item("routine", "p4", "s.f()"),
                item("type", "t5", "s.ty"),
            ],
            [
                ["c3", "c1"],
                ["c2", "p4"],
                ["c9", "c1"], // not in the script: ignored
            ],
        );
        expect(order.map((i: { key: string }) => i.key)).toEqual(["t5", "p4", "c2", "c1", "c3"]);
    });

    it("counts a dependency on a partition for its table, and survives a cycle", () => {
        const order = dependencyOrder(
            [item("view", "c3", "s.v"), item("table", "c1", "s.t"), item("routine", "p2", "s.f()")],
            [
                ["c3", "c7"],
                ["p2", "c3"],
                ["c3", "p2"],
            ],
            new Map([["c7", "c1"]]),
        );
        expect(order.map((i: { key: string }) => i.key)).toEqual(["c1", "p2", "c3"]);
    });
});

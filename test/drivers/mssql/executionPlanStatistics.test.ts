import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { convertShowPlanXml, parseShowPlanXml } from "../../../src/drivers/mssql/executionPlan";
import { addExecutionPlanStatistics } from "../../../src/drivers/mssql/executionPlan/planStatistics";
import type {
    ExecutionPlanGraph,
    ExecutionPlanNode,
} from "../../../src/sharedInterfaces/executionPlan";

// The SQL Server driver's parse = sqltoolsservice's graphs (executionPlanReference.test.ts) plus
// the actual-plan counters vscode-mssql adds (addExecutionPlanStatistics of
// queryResult/liveExecutionPlanStatistics.ts). Expected values below were read by hand from the
// captured XML.

interface Capture {
    cases: { name: string; kind: string; plans: { xml: string }[] }[];
}

const capture: Capture = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "../../../docs/reference/mssql-execution-plans.json"),
        "utf8",
    ),
);
const xmlOf = (name: string, index = 0) =>
    capture.cases.find((c) => c.name === name)!.plans[index].xml;

/** The operator whose "Node ID" property is `id`. */
function nodeWithId(root: ExecutionPlanNode, id: string): ExecutionPlanNode | undefined {
    if (root.properties.some((p) => p.name === "Node ID" && p.value === id)) return root;
    for (const child of root.children) {
        const found = nodeWithId(child, id);
        if (found) return found;
    }
    return undefined;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("actual-plan counters (vscode-mssql's addExecutionPlanStatistics)", () => {
    it("is what the SQL Server driver's parse returns", () => {
        expect(mssqlDriver.executionPlan!.parse).toBe(parseShowPlanXml);
    });

    it("parallel operator: rows summed over the threads, elapsed time the threads' maximum", () => {
        const [graph] = parseShowPlanXml(xmlOf("parallelism (actual)"));
        // NodeId 6, Clustered Index Scan: 13 threads, ActualRows summing to 200000,
        // ActualElapsedms at most 2; EstimateRows 200000, no rebinds or rewinds.
        expect(nodeWithId(graph.root, "6")!.liveQueryStatistics).toEqual({
            actualRows: "200000",
            estimatedRows: 200000,
            elapsedTimeInMs: 2,
        });
        // QueryTimeStats ElapsedTime="5", above every operator's elapsed time.
        expect(graph.liveQueryStatistics).toEqual({
            estimatedProgress: undefined,
            elapsedTimeInMs: 5,
        });
        expect(graph.root.liveQueryStatistics).toEqual({ elapsedTimeInMs: 5 });
    });

    it("inner side of a nested loop: estimated rows times 1 + rebinds + rewinds", () => {
        const [graph] = parseShowPlanXml(xmlOf("index-seek-key-lookup (actual)"));
        // NodeId 4, the key lookup: EstimateRows="1" EstimateRebinds="1999" EstimateRewinds="0",
        // one thread with ActualRows="2000" ActualElapsedms="3".
        expect(nodeWithId(graph.root, "4")!.liveQueryStatistics).toEqual({
            actualRows: "2000",
            estimatedRows: 2000,
            elapsedTimeInMs: 3,
        });
        expect(graph.liveQueryStatistics?.elapsedTimeInMs).toBe(6);
    });

    it("annotates every operator of every actual plan, leaving sqltoolsservice's fields as they are", () => {
        const actual = capture.cases.filter((c) => c.kind === "actual").flatMap((c) => c.plans);
        expect(actual.length).toBeGreaterThan(40);
        for (const { xml } of actual) {
            const base = convertShowPlanXml(xml);
            const enriched = parseShowPlanXml(xml);
            enriched.forEach((graph, index) => {
                expect(graph.liveQueryStatistics).toBeDefined();
                // Removing the counters gives back sqltoolsservice's graph exactly.
                const strip = (node: ExecutionPlanNode): ExecutionPlanNode => {
                    const { liveQueryStatistics: _, ...rest } = node;
                    return { ...rest, children: node.children.map(strip) } as ExecutionPlanNode;
                };
                const { liveQueryStatistics: _, ...rest } = graph;
                expect(json({ ...rest, root: strip(graph.root) })).toEqual(json(base[index]));
                const visit = (node: ExecutionPlanNode) => {
                    expect(node.liveQueryStatistics).toBeDefined();
                    node.children.forEach(visit);
                };
                graph.root.children.forEach(visit);
            });
        }
    });

    it("leaves estimated plans and Microsoft's fixtures unchanged", () => {
        const others = capture.cases.filter((c) => c.kind !== "actual").flatMap((c) => c.plans);
        for (const { xml } of others) {
            expect(json(parseShowPlanXml(xml))).toEqual(json(convertShowPlanXml(xml)));
            // The same objects, as upstream returns them (its service compares identity).
            const graphs = convertShowPlanXml(xml);
            addExecutionPlanStatistics(graphs).forEach((graph, i) => expect(graph).toBe(graphs[i]));
        }
    });

    it("takes the statement's elapsed time from its slowest operator when QueryTimeStats is lower", () => {
        const xml = xmlOf("hash-spill (actual)");
        const slowest = Math.max(
            ...[...xml.matchAll(/ActualElapsedms="(\d+)"/g)].map((m) => Number(m[1])),
        );
        const lowered = xml.replace(
            /<QueryTimeStats ([^>]*?)ElapsedTime="\d+"/,
            '<QueryTimeStats $1ElapsedTime="1"',
        );
        expect(lowered).not.toBe(xml);
        const [graph] = parseShowPlanXml(lowered);
        expect(slowest).toBeGreaterThan(1);
        expect(graph.liveQueryStatistics?.elapsedTimeInMs).toBe(slowest);
        expect(graph.root.liveQueryStatistics).toEqual({ elapsedTimeInMs: slowest });
    });

    it("matches each graph of a several-statement document with its own statement", () => {
        // An estimated document of three statements, with run-time counters given to the first
        // operator of the second statement only.
        const xml = xmlOf("several-statements (estimated)");
        const statements = xml.split("<StmtSimple ");
        expect(statements).toHaveLength(4);
        statements[2] = statements[2].replace(
            /(<RelOp [^>]*>)/,
            '$1<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="7" ActualElapsedms="4" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>',
        );
        const graphs = parseShowPlanXml(statements.join("<StmtSimple "));
        expect(graphs).toHaveLength(3);
        expect(graphs[0].liveQueryStatistics).toBeUndefined();
        expect(graphs[2].liveQueryStatistics).toBeUndefined();
        expect(graphs[1].root.children[0].liveQueryStatistics).toMatchObject({
            actualRows: "7",
            elapsedTimeInMs: 4,
        });
    });

    it("leaves alone the statement shapes it cannot match, as upstream does", () => {
        const xml = xmlOf("parallelism (actual)");
        const [graph] = convertShowPlanXml(xml);
        // A statement node with two operator children.
        const twoChildren: ExecutionPlanGraph = {
            ...graph,
            root: { ...graph.root, children: [graph.root.children[0], graph.root.children[0]] },
        };
        expect(addExecutionPlanStatistics([twoChildren])[0]).toBe(twoChildren);
        // A graph whose operators do not match the XML's.
        const pruned: ExecutionPlanGraph = {
            ...graph,
            root: {
                ...graph.root,
                children: [{ ...graph.root.children[0], children: [] }],
            },
        };
        expect(addExecutionPlanStatistics([pruned])[0]).toBe(pruned);
        // A graph whose statement text matches no statement of the document.
        const otherIndex: ExecutionPlanGraph = {
            ...graph,
            query: "SELECT 'something else'",
            graphFile: { ...graph.graphFile, planIndexInFile: 5 },
        };
        expect(addExecutionPlanStatistics([otherIndex])[0]).toBe(otherIndex);
        // A document that does not parse.
        const broken: ExecutionPlanGraph = {
            ...graph,
            graphFile: { ...graph.graphFile, graphFileContent: "<ShowPlanXML" },
        };
        expect(addExecutionPlanStatistics([broken])[0]).toBe(broken);
    });
});

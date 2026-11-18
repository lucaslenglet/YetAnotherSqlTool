import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mssqlDriver } from "../../../src/drivers/mssql";
import { convertShowPlanXml } from "../../../src/drivers/mssql/executionPlan";

// docs/reference/mssql-execution-plans.json holds, for showplan XML documents of real queries
// (estimated and actual plans) and for sqltoolsservice's own fixtures, the graphs sqltoolsservice's
// queryExecutionPlan/getExecutionPlan returned (tools/sts-plan-probe.js). The converter must give
// exactly the same JSON. Two things in the capture are by design (see its "note"):
//   - graphFileContent is "$xml" when it is the input document, to keep the file small;
//   - topOperationsData was removed from every node: the page does not use it, YAST does not make it.

interface CapturedPlan {
    xml: string;
    graphs?: unknown[];
    error?: string;
}

interface Capture {
    note: string;
    cases: { name: string; kind: string; query?: string; plans: CapturedPlan[] }[];
}

const capture: Capture = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "../../../docs/reference/mssql-execution-plans.json"),
        "utf8",
    ),
);

/** The converter's output as JSON would carry it, with the capture's "$xml" convention. */
function convert(xml: string): unknown {
    const graphs = JSON.parse(JSON.stringify(convertShowPlanXml(xml)));
    for (const graph of graphs) {
        if (graph.graphFile.graphFileContent === xml) graph.graphFile.graphFileContent = "$xml";
    }
    return graphs;
}

describe("showplan XML to sqltoolsservice's graphs", () => {
    it("covers estimated and actual plans and Microsoft's fixtures", () => {
        const kinds = new Set(capture.cases.map((c) => c.kind));
        expect(kinds).toEqual(new Set(["estimated", "actual", "file"]));
        expect(capture.cases.flatMap((c) => c.plans).length).toBeGreaterThan(90);
    });

    for (const testCase of capture.cases) {
        testCase.plans.forEach((plan, index) => {
            it(`${testCase.name}${testCase.plans.length > 1 ? `, plan ${index + 1}` : ""}`, () => {
                expect(plan.error).toBeUndefined();
                expect(convert(plan.xml)).toEqual(plan.graphs);
            });
        });
    }
});

describe("the SQL Server driver's execution plan support", () => {
    it("saves plans as .sqlplan, opened as XML", () => {
        expect(mssqlDriver.executionPlan).toMatchObject({
            fileExtension: "sqlplan",
            documentLanguage: "xml",
        });
    });

    it("throws a readable error for a document that is not a plan", () => {
        const parse = mssqlDriver.executionPlan!.parse;
        expect(() => parse("not xml")).toThrow(/Invalid XML/);
        expect(() => parse("<plan/>")).toThrow(/<plan xmlns=''> was not expected/);
        expect(() =>
            parse(
                '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementId="1" StatementType="SELECT"><QueryPlan><RelOp NodeId="0" PhysicalOp="Teleport" LogicalOp="Inner Join" EstimateRows="1" EstimatedTotalSubtreeCost="1" AvgRowSize="1" EstimateCPU="0" EstimateIO="0" EstimateRebinds="0" EstimateRewinds="0" Parallel="0"/></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>',
            ),
        ).toThrow(/'Teleport' is not a valid value for PhysicalOpType/);
    });

    it("gives no graph for a plan document without statements", () => {
        const xml =
            '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564"><BatchSequence/></ShowPlanXML>';
        expect(mssqlDriver.executionPlan!.parse(xml)).toEqual([]);
    });
});

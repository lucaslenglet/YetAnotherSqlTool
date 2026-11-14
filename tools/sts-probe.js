// Dev tool: probes Microsoft's sqltoolsservice (installed with the mssql extension) to capture
// reference data: connection capabilities and the Object Explorer tree of the Docker SQL Server.
// Usage: start the databases with `npm run dev:db` in another terminal, then run
//   MSSQL_SA_PASSWORD='<password printed by dev:db>' node tools/sts-probe.js docs/reference
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const rpc = require(path.join(__dirname, "../node_modules/vscode-jsonrpc/lib/node/main.js"));

const STS = path.join(
    process.env.HOME,
    ".vscode/extensions/ms-mssql.mssql-1.46.0/sqltoolsservice/6.0.20260918.1/Portable/MicrosoftSqlToolsServiceLayer.dll",
);
const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });

const proc = cp.spawn("dotnet", [STS], { stdio: ["pipe", "pipe", "ignore"] });
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(proc.stdout),
    new rpc.StreamMessageWriter(proc.stdin),
);
const waiters = { sessioncreated: [], expandCompleted: [] };
conn.onNotification("objectexplorer/sessioncreated", (p) => waiters.sessioncreated.shift()?.(p));
const pendingExpand = new Map();
conn.onNotification("objectexplorer/expandCompleted", (p) => {
    const r = pendingExpand.get(p.nodePath);
    pendingExpand.delete(p.nodePath);
    r?.(p);
});
conn.onNotification(() => {});
conn.listen();

const timeout = (ms, what) =>
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + what)), ms));

(async () => {
    try {
        const caps = await Promise.race([
            conn.sendRequest("capabilities/list", { hostName: "probe", hostVersion: "1.0" }),
            timeout(60000, "caps"),
        ]);
        fs.writeFileSync(
            path.join(outDir, "mssql-capabilities.json"),
            JSON.stringify(caps, null, 2),
        );
        console.log(
            "capabilities:",
            caps.capabilities.connectionProvider.options.length,
            "options",
        );

        const options = {
            server: "localhost,11433",
            database: "",
            user: "sa",
            password: process.env.MSSQL_SA_PASSWORD,
            authenticationType: "SqlLogin",
            trustServerCertificate: true,
            encrypt: "Mandatory",
            applicationName: "probe",
        };
        const created = new Promise((r) => waiters.sessioncreated.push(r));
        await conn.sendRequest("objectexplorer/createsession", { options });
        const root = await Promise.race([created, timeout(60000, "session")]);
        if (!root.success) throw new Error("session failed: " + root.errorMessage);
        const sessionId = root.sessionId;

        const expand = async (nodePath) => {
            const p = new Promise((r) => pendingExpand.set(nodePath, r));
            await conn.sendRequest("objectexplorer/expand", { sessionId, nodePath });
            return Promise.race([p, timeout(60000, "expand " + nodePath)]);
        };

        // Walk the tree: full depth under the "yast" database (limited), shallow elsewhere.
        const tree = { ...root.rootNode, children: [] };
        let count = 0;
        const walk = async (node, depth) => {
            if (node.isLeaf || depth > 7 || count > 600) return;
            const inYast = node.nodePath.includes("/yast") || depth <= 2;
            if (!inYast) return;
            const res = await expand(node.nodePath);
            node.children = (res.nodes || []).map((n) => ({ ...n }));
            if (res.errorMessage) node.expandError = res.errorMessage;
            count += node.children.length;
            for (const c of node.children) {
                // keep generic sub-folders shallow except under the customers/orders tables
                const deep = /customers|orders/.test(c.nodePath) || depth < 5;
                if (deep) await walk(c, depth + 1);
            }
        };
        await walk(tree, 0);
        fs.writeFileSync(
            path.join(outDir, "mssql-object-explorer-tree.json"),
            JSON.stringify(tree, null, 2),
        );
        console.log("tree nodes:", count);
    } catch (e) {
        console.error("ERROR", e.message);
        process.exitCode = 1;
    } finally {
        proc.kill();
        process.exit();
    }
})();

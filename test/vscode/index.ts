// Entry point VS Code calls (--extensionTestsPath): runs the mocha suites of this folder inside
// the extension host of the test window. Started by scripts/test-vscode.mjs.

import * as path from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";
import { closeAllSessions } from "./cdp";
import { dumpDom } from "./helpers";

// In this order: each suite leaves the window in the state the next one starts from.
const suites = [
    "packaging.e2e.js",
    "objectExplorer.e2e.js",
    "connectionFilter.e2e.js",
    "scripting.e2e.js",
    "queries.e2e.js",
    "shortcuts.e2e.js",
    "largeResults.e2e.js",
    "webviews.e2e.js",
    "highlighting.e2e.js",
    "completion.e2e.js",
];

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60000, slow: 10000 });
    for (const suite of suites) {
        mocha.addFile(path.join(__dirname, suite));
    }
    mocha.rootHooks({
        async afterEach(this: Mocha.Context) {
            const test = this.currentTest;
            if (test && (test.state === "failed" || process.env.YAST_TEST_DUMP_ALL)) {
                // What was on screen when it failed: see .vscode-test/run/artifacts.
                await dumpDom(test.fullTitle());
            }
            if (test?.state === "failed") {
                // A quick pick the test left open would swallow the commands of the next ones.
                await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
            }
        },
        afterAll() {
            closeAllSessions();
        },
    });
    return new Promise((resolve, reject) => {
        mocha.run((failures) =>
            failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve(),
        );
    });
}

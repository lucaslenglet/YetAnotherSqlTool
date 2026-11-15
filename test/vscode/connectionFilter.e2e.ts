// A connection with a database filter (profiles "Filtered ..." of scripts/test-vscode.mjs): the
// Object Explorer lists only the databases that match, and the folders say so; the "change
// database" list of an editor connected through it holds the matching databases and the current one.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { env, type TestProfile } from "./env";
import {
    clickObjectExplorerRow,
    codeLensTitles,
    errorNotifications,
    objectExplorerRows,
    pickFromCommand,
    quickPickItems,
    waitFor,
} from "./helpers";

/** Rows right under the row with this label: label and description of each. */
async function childrenOf(label: string): Promise<{ label: string; description: string }[]> {
    const rows = await objectExplorerRows();
    const start = rows.findIndex((r) => r.label === label);
    if (start < 0) {
        return [];
    }
    const children: { label: string; description: string }[] = [];
    for (const row of rows.slice(start + 1)) {
        if (row.level <= rows[start].level) break;
        if (row.level === rows[start].level + 1) {
            children.push({ label: row.label, description: row.description });
        }
    }
    return children;
}

/** Children are there, not the "Loading..." item that stands in for them. */
const loaded = (labels: string[]) => labels.length > 0 && !labels.includes("Loading...");

const descriptionOf = async (label: string) =>
    (await objectExplorerRows()).find((r) => r.label === label)?.description;

/** Databases the filter of each engine lets through, among the ones every test server has. */
const expected = {
    // "ms*": no user database (the profile's own database, yast, is hidden), msdb among the system ones.
    mssql: { listed: [], system: ["msdb"], picker: ["msdb", "yast"] },
    pg: { listed: ["postgres"], system: undefined, picker: ["postgres", "yast"] },
};

for (const provider of ["mssql", "pg"] as const) {
    describe(`Connection with a database filter, on ${provider}`, () => {
        const profile = () =>
            env.profiles.find((p) => p.id === `filtered-${provider}`) as TestProfile;

        it("lists only the matching databases in the Object Explorer, and marks the folder", async () => {
            await vscode.commands.executeCommand("yastObjectExplorer.focus");
            const name = profile().profileName;
            await clickObjectExplorerRow(name);
            await waitFor(
                `the folders under "${name}"`,
                async () => (await childrenOf(name)).map((c) => c.label),
                (labels) => labels.includes("Databases"),
                40000,
            );

            await clickObjectExplorerRow("Databases");
            // What the folder lists once loaded: "(filtered)" and the databases that match.
            const databases = (await waitFor(
                `the databases under "${name}"`,
                async () =>
                    (await descriptionOf("Databases")) === "(filtered)"
                        ? (await childrenOf("Databases")).map((c) => c.label)
                        : undefined,
                (labels) => labels !== undefined && loaded(labels),
                40000,
            )) as string[];
            const { listed, system } = expected[provider];
            if (system) {
                assert.deepStrictEqual(
                    databases.filter((l) => l !== "System Databases"),
                    listed,
                );
                assert.ok(databases.includes("System Databases"), JSON.stringify(databases));
            } else {
                assert.deepStrictEqual(databases, listed);
            }
            const labels = (await objectExplorerRows()).map((r) => r.label);
            assert.ok(!labels.includes("yast"), `yast is listed: ${JSON.stringify(labels)}`);
            assert.ok(!labels.includes("master"), `master is listed: ${JSON.stringify(labels)}`);

            if (system) {
                // The system databases are filtered too.
                await clickObjectExplorerRow("System Databases");
                const systemDatabases = await waitFor(
                    "the system databases",
                    async () => (await childrenOf("System Databases")).map((c) => c.label),
                    loaded,
                    40000,
                );
                assert.deepStrictEqual(systemDatabases, system);
                assert.strictEqual(await descriptionOf("System Databases"), "(filtered)");
            }
            assert.deepStrictEqual(await errorNotifications(), []);

            // Collapse, so that the next connection is in sight whatever the height of the window.
            await clickObjectExplorerRow(name);
            await waitFor(
                `"${name}" collapsed`,
                () => childrenOf(name),
                (children) => children.length === 0,
            );
        });

        describe("SQL editor", () => {
            let editor: vscode.TextEditor;

            before(async () => {
                const folder = vscode.workspace.workspaceFolders?.[0];
                assert.ok(folder, "the test window has no workspace folder");
                const document = await vscode.workspace.openTextDocument(
                    vscode.Uri.joinPath(folder.uri, `${provider}.sql`),
                );
                editor = await vscode.window.showTextDocument(document, { preview: false });
            });

            after(async () => {
                await vscode.window.showTextDocument(editor.document);
                await vscode.commands.executeCommand("yast.disconnect");
                await waitFor(
                    "the editor to be disconnected",
                    () => codeLensTitles(editor.document.uri),
                    (titles) => titles.length === 1,
                );
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            });

            it("offers the matching databases and the current one in the change database list", async () => {
                const { profileName, database } = profile();
                await pickFromCommand("yast.connect", profileName);
                await waitFor(
                    "the CodeLenses of the connection",
                    () => codeLensTitles(editor.document.uri),
                    (titles) => titles.length === 3 && titles[2].includes(database),
                );

                await vscode.window.showTextDocument(editor.document);
                const picking = vscode.commands.executeCommand("yast.changeDatabase");
                // The label comes first; the current database carries a check mark after it.
                const namesOf = (list: string[]) => list.map((item) => item.split(/[,\s]/)[0]);
                // The widget may still hold the rows of the connection quick pick when it opens
                // again: wait for the current database, which the list always has.
                const items = await waitFor(
                    "the databases in the quick pick",
                    quickPickItems,
                    (list) => namesOf(list).includes(database),
                );
                const names = namesOf(items);
                assert.deepStrictEqual(names, expected[provider].picker, JSON.stringify(items));
                await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
                await picking;
                assert.deepStrictEqual(await errorNotifications(), []);
            });
        });
    });
}

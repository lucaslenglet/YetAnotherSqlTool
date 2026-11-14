// The Object Explorer tree, driven with the mouse: expanding a saved connection connects to the
// server with the packaged driver and lists what it holds.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { workbench } from "./cdp";
import { env, type TestProfile } from "./env";
import { errorNotifications, objectExplorerRows, waitFor } from "./helpers";

/** Clicks the tree row with this label, which expands or collapses it. */
async function clickRow(label: string): Promise<void> {
    const row = await waitFor(`the Object Explorer row "${label}"`, async () =>
        (await objectExplorerRows()).find((r) => r.label === label),
    );
    await (await workbench()).clickAt(row!.x, row!.y);
}

/** Labels of the rows right under the row with this label. */
async function childrenOf(label: string): Promise<string[]> {
    const rows = await objectExplorerRows();
    const start = rows.findIndex((r) => r.label === label);
    if (start < 0) {
        return [];
    }
    const children: string[] = [];
    for (const row of rows.slice(start + 1)) {
        if (row.level <= rows[start].level) break;
        if (row.level === rows[start].level + 1) children.push(row.label);
    }
    return children;
}

describe("Object Explorer", () => {
    before(async () => {
        await vscode.commands.executeCommand("yastObjectExplorer.focus");
    });

    it("lists the connection profiles of the settings", async () => {
        const expected = env.profiles.map((p) => p.profileName).sort();
        const labels = await waitFor(
            "the saved connections in the tree",
            async () => (await objectExplorerRows()).map((r) => r.label),
            (rows) => expected.every((name) => rows.includes(name)),
        );
        assert.deepStrictEqual(labels.sort(), expected);
    });

    for (const provider of ["mssql", "pg"] as const) {
        const profile = () => env.profiles.find((p) => p.provider === provider) as TestProfile;

        it(`${provider}: expanding a connection connects and lists its databases`, async () => {
            const name = profile().profileName;
            await clickRow(name);
            const folders = await waitFor(
                `the folders under "${name}"`,
                () => childrenOf(name),
                (children) => children.includes("Databases"),
                40000,
            );
            assert.ok(folders.includes("Databases"), JSON.stringify(folders));

            await clickRow("Databases");
            await waitFor(
                `the databases under "${name}"`,
                async () => (await objectExplorerRows()).map((r) => r.label),
                (labels) => labels.includes(profile().database),
                40000,
            );
            assert.deepStrictEqual(await errorNotifications(), []);

            // Collapse, so that the next connection is in sight whatever the height of the window.
            await clickRow(name);
            await waitFor(
                `"${name}" collapsed`,
                () => childrenOf(name),
                (children) => children.length === 0,
            );
        });
    }
});

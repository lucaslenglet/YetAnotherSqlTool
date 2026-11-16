// "Import Connections from SQL Server Extension": the connections and groups of vscode-mssql, put
// in the user settings of the test window (the SQL Server extension is not installed there: the
// command only reads its settings), appear in the Connections view; a second run offers nothing
// new. The suite puts the settings back at the end.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { workbench } from "./cdp";
import { env } from "./env";
import { objectExplorerRows, quickPickItems, waitFor } from "./helpers";

const mssqlGroups = [
    { id: "ROOT", name: "ROOT" },
    { id: "g-prod", name: "Imported Prod", parentId: "ROOT", color: "#c50f1f" },
    { id: "g-eu", name: "Imported EU", parentId: "g-prod" },
    { id: "g-unused", name: "Imported Unused", parentId: "ROOT" },
];
const mssqlConnections = [
    {
        id: "m-sql",
        groupId: "g-eu",
        profileName: "Imported SQL login",
        server: "imported-sql.invalid",
        database: "sales",
        user: "reader",
        authenticationType: "SqlLogin",
        savePassword: true,
        pooling: true,
        maxPoolSize: 20,
    },
    {
        id: "m-entra",
        groupId: "g-prod",
        profileName: "Imported Entra ID",
        server: "imported-entra.invalid",
        authenticationType: "AzureMFA",
        user: "someone@example.invalid",
        email: "someone@example.invalid",
        accountId: "00000000-0000-0000-0000-000000000001.00000000-0000-0000-0000-000000000002",
    },
    {
        id: "m-root",
        profileName: "Imported at the root",
        server: "imported-root.invalid",
        authenticationType: "Integrated",
    },
    {
        id: "m-refused",
        profileName: "Imported refused",
        server: "imported-refused.invalid",
        authenticationType: "ActiveDirectoryPassword",
    },
];

const settingsFile = env.userSettingsFile;
let originalSettings: string;
let originalYast: { connections: unknown; groups: unknown };

const yast = () => vscode.workspace.getConfiguration("yast");

/** Writes the settings file by hand: `mssql.*` is not a setting of any installed extension. */
function writeSettings(extra: Record<string, unknown>): void {
    const settings = JSON.parse(originalSettings) as Record<string, unknown>;
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, ...extra }, null, 4));
}

const mssqlConnectionsSeen = () =>
    (
        vscode.workspace.getConfiguration("mssql").inspect("connections")?.globalValue as
            unknown[] | undefined
    )?.length;

async function screenshot(name: string): Promise<void> {
    const dir = process.env.YAST_TEST_SCREENSHOTS;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const { data } = await (
        await workbench()
    ).send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
    });
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, "base64"));
}

const importedRows = async () =>
    (await objectExplorerRows()).filter((r) => r.label.startsWith("Imported "));

async function openQuickPick(): Promise<string[]> {
    void vscode.commands.executeCommand("yast.importMssqlConnections");
    return waitFor("the connections to import in the quick pick", quickPickItems, (items) =>
        items.some((i) => i.includes("Imported SQL login")),
    );
}

describe("Import connections from the SQL Server extension", () => {
    before(async () => {
        originalSettings = fs.readFileSync(settingsFile, "utf8");
        originalYast = {
            connections: yast().inspect("connections")?.globalValue,
            groups: yast().inspect("connectionGroups")?.globalValue,
        };
        writeSettings({
            "mssql.connections": mssqlConnections,
            "mssql.connectionGroups": mssqlGroups,
        });
        await waitFor(
            "the settings of the SQL Server extension",
            mssqlConnectionsSeen,
            (n) => n === 4,
        );
        await vscode.commands.executeCommand("yastObjectExplorer.focus");
    });

    after(async () => {
        await vscode.commands.executeCommand("notifications.clearAll");
        fs.writeFileSync(settingsFile, originalSettings);
        await yast().update(
            "connections",
            originalYast.connections,
            vscode.ConfigurationTarget.Global,
        );
        await yast().update(
            "connectionGroups",
            originalYast.groups,
            vscode.ConfigurationTarget.Global,
        );
    });

    it("lists the connections with their groups, then adds the chosen ones to the view", async () => {
        const items = await openQuickPick();
        assert.ok(
            items.some((i) => i.includes("Imported EU") || i.includes("Imported Prod")),
            JSON.stringify(items),
        );
        // The profile the driver cannot connect with is not offered.
        assert.ok(!items.some((i) => i.includes("Imported refused")), JSON.stringify(items));
        await screenshot("import-quick-pick");
        await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");

        // Only the final state has the nested group and the connection under it.
        const rows = await waitFor(
            "the imported groups and connections in the Connections view",
            importedRows,
            (r) => r.some((x) => x.label === "Imported SQL login"),
            30000,
        );
        const level = (label: string) => rows.find((r) => r.label === label)?.level;
        assert.strictEqual(level("Imported Prod"), level("Imported at the root")!);
        assert.strictEqual(level("Imported EU"), level("Imported Prod")! + 1);
        assert.strictEqual(level("Imported SQL login"), level("Imported EU")! + 1);
        assert.strictEqual(level("Imported Entra ID"), level("Imported Prod")! + 1);
        assert.ok(
            !rows.some((r) => r.label === "Imported Unused"),
            "a group no profile needs was created",
        );
        assert.ok(!rows.some((r) => r.label === "Imported refused"));
        await screenshot("import-connections-view");

        const saved = yast().get<Record<string, unknown>[]>("connections", []);
        const sql = saved.find((p) => p.profileName === "Imported SQL login")!;
        assert.strictEqual(sql.authenticationType, "SqlLogin");
        assert.strictEqual(sql.savePassword, true);
        assert.ok(!("pooling" in sql), "an option YAST ignores was copied");
        const groups = yast().get<{ id: string; name: string }[]>("connectionGroups", []);
        assert.strictEqual(sql.groupId, groups.find((g) => g.name === "Imported EU")?.id);

        // The settings of the SQL Server extension are untouched.
        assert.deepStrictEqual(
            vscode.workspace.getConfiguration("mssql").inspect("connections")?.globalValue,
            mssqlConnections,
        );
    });

    it("finds them in YAST on a second run, and adds nothing", async () => {
        await vscode.commands.executeCommand("notifications.clearAll");
        const before = yast().get<unknown[]>("connections", []).length;
        const items = await openQuickPick();
        const present = items.filter((i) => i.includes("Already present"));
        assert.strictEqual(present.length, 3, JSON.stringify(items));
        await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
        assert.strictEqual(yast().get<unknown[]>("connections", []).length, before);
        assert.strictEqual(
            (await importedRows()).filter((r) => r.label === "Imported SQL login").length,
            1,
        );
    });
});

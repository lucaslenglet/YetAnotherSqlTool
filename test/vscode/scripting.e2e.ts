// "Select Top 1000" on a table of the real Object Explorer tree: the command opens a new SQL
// editor holding the engine's script, connects it like the node and runs it. "Script as Create /
// Drop / Alter / Execute" open the script without running it. "Generate Scripts..." scripts a
// whole database into an editor or a file.

import * as assert from "node:assert";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sql from "mssql";
import { Client } from "pg";
import * as vscode from "vscode";
import { workbench } from "./cdp";
import { env, profile, type TestProfile } from "./env";
import {
    codeLensTitles,
    errorNotifications,
    extension,
    inWorkbench,
    objectExplorerRows,
    quickPickItems,
    sleep,
    waitFor,
    waitForWebview,
} from "./helpers";

/** Clicks the tree row with this label, which selects it and expands or collapses it. */
async function clickRow(label: string): Promise<void> {
    const row = await waitFor(`the Object Explorer row "${label}"`, async () =>
        (await objectExplorerRows()).find((r) => r.label === label),
    );
    await (await workbench()).clickAt(row!.x, row!.y);
}

/**
 * Opens the rows of a path one after the other (a connection takes a moment) and selects the
 * last one. A row that is already expanded, as the previous suites left it, is not clicked again.
 */
async function walkTo(path: string[]): Promise<void> {
    for (const [index, label] of path.entries()) {
        const row = await waitFor(
            `the row "${label}"`,
            async () => (await objectExplorerRows()).find((r) => r.label === label),
            Boolean,
            40000,
        );
        if (index === path.length - 1 || row!.expanded !== "true") {
            await clickRow(label);
        }
    }
}

interface MenuEntry {
    command: string;
    when?: string;
    group?: string;
}

/** The `viewItem =~ /.../` pattern of a `when` clause, as a RegExp. */
function viewItemPattern(when: string): RegExp {
    const match = /viewItem =~ \/(.*)\/(?:\s|$|&)/.exec(when);
    assert.ok(match, `no viewItem pattern in "${when}"`);
    return new RegExp(match[1]);
}

describe("Select Top 1000 menu entries", () => {
    const menus = () =>
        (extension().packageJSON.contributes.menus ?? {}) as Record<string, MenuEntry[]>;

    it("is contributed for tables and views of the Object Explorer, not for other nodes", () => {
        const entries = menus()["view/item/context"].filter(
            (e) => e.command === "yast.scriptSelect",
        );
        assert.strictEqual(entries.length, 2);
        const matches = (contextValue: string) =>
            entries.filter((e) => viewItemPattern(e.when!).test(contextValue)).length;
        // Context values are "type=<nodeType>,subType=..." (see TreeNodeInfo).
        assert.strictEqual(matches("type=Table,"), 1);
        assert.strictEqual(matches("type=Table,subType=Temporal,"), 1);
        assert.strictEqual(matches("type=View,"), 1);
        for (const other of ["Server", "Database", "Folder", "Column", "StoredProcedure"]) {
            assert.strictEqual(matches(`type=${other},`), 0, other);
        }
        for (const entry of entries) {
            assert.ok(entry.when!.startsWith("view == yastObjectExplorer"), entry.when);
        }
    });

    it("is hidden from the command palette", () => {
        const hidden = menus().commandPalette.find((e) => e.command === "yast.scriptSelect");
        assert.strictEqual(hidden?.when, "false");
    });
});

function scriptSelectOn(provider: TestProfile["provider"]): void {
    describe(`Select Top 1000 on ${provider}`, () => {
        const customers = ["Alice", "alice@example.com", "Chloé", "chloe@example.com"];
        const expectedScript =
            provider === "mssql"
                ? [
                      "SELECT TOP (1000) [id]",
                      "      ,[name]",
                      "      ,[email]",
                      "      ,[created_at]",
                      "  FROM [yast].[dbo].[customers]",
                  ]
                : [
                      "SELECT id",
                      "      ,name",
                      "      ,email",
                      "      ,created_at",
                      "  FROM public.customers",
                      "  LIMIT 1000",
                  ];

        before(async () => {
            await vscode.commands.executeCommand("yastObjectExplorer.focus");
        });

        after(async () => {
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            // Collapse the connection so that the next one is in sight whatever the window height.
            await clickRow(profile(provider).profileName);
        });

        it("opens a connected editor with the script and shows the rows", async () => {
            const { profileName, database } = profile(provider);
            const path =
                provider === "mssql"
                    ? [profileName, "Databases", database, "Tables", "dbo.customers"]
                    : [
                          profileName,
                          "Databases",
                          database,
                          "Schemas",
                          "public",
                          "Tables",
                          "customers",
                      ];
            await walkTo(path);

            const before = vscode.window.visibleTextEditors.length;
            // No argument: the command takes the node selected in the tree, like the menu does.
            await vscode.commands.executeCommand("yast.scriptSelect");

            const editor = await waitFor(
                "a new SQL editor with the script",
                () => vscode.window.activeTextEditor,
                (e) => !!e && e.document.isUntitled && e.document.getText().length > 0,
            );
            assert.strictEqual(editor!.document.languageId, "sql");
            assert.strictEqual(editor!.document.getText(), expectedScript.join("\n"));
            assert.ok(vscode.window.visibleTextEditors.length >= before);

            // Connected like the node: same profile, the node's database.
            const titles = await waitFor(
                "the CodeLenses of the connection",
                () => codeLensTitles(editor!.document.uri),
                (t) => t.length === 3,
            );
            assert.ok(titles[0].includes(profileName), JSON.stringify(titles));
            assert.ok(titles[2].includes(database), JSON.stringify(titles));

            // And run: the rows are in the results webview.
            const webview = await waitForWebview(
                "queryResult",
                `document.body.innerText.includes("chloe@example.com")`,
            );
            const text = await webview.text();
            for (const cell of customers) {
                assert.ok(text.includes(cell), `"${cell}" is not in the results grid:\n${text}`);
            }
            assert.deepStrictEqual(await errorNotifications(), []);
            assert.ok(env.profiles.length > 0);
        });
    });
}

scriptSelectOn("mssql");
scriptSelectOn("pg");

describe("Script as menu entries", () => {
    const menus = () =>
        (extension().packageJSON.contributes.menus ?? {}) as Record<
            string,
            Array<MenuEntry & { submenu?: string }>
        >;
    const entriesOf = (command: string) =>
        menus()["view/item/context"].filter((e) => e.command === command);

    it("puts Create and Drop of tables in the Generate Script submenu", () => {
        const submenu = menus()["view/item/context"].find(
            (e) => e.submenu === "yast.sqlScriptsSubmenu",
        );
        assert.ok(submenu, "no Generate Script submenu");
        assert.ok(viewItemPattern(submenu.when!).test("type=Table,"));
        assert.ok(!viewItemPattern(submenu.when!).test("type=View,"));
        assert.deepStrictEqual(
            menus()["yast.sqlScriptsSubmenu"].map((e) => e.command),
            ["yast.scriptCreate", "yast.scriptDelete"],
        );
        const submenus = (extension().packageJSON.contributes.submenus ?? []) as Array<{
            id: string;
        }>;
        assert.ok(submenus.some((s) => s.id === "yast.sqlScriptsSubmenu"));
    });

    it("offers each operation on the node types that support it", () => {
        const offered = (command: string, type: string) =>
            entriesOf(command).some((e) => viewItemPattern(e.when!).test(`type=${type},`));
        for (const type of ["View", "StoredProcedure", "ScalarValuedFunction", "Index", "Key"]) {
            assert.ok(offered("yast.scriptCreate", type), `Create on ${type}`);
            assert.ok(offered("yast.scriptDelete", type), `Drop on ${type}`);
        }
        assert.ok(offered("yast.scriptAlter", "View"));
        assert.ok(!offered("yast.scriptAlter", "Table"));
        assert.ok(offered("yast.scriptExecute", "StoredProcedure"));
        assert.ok(!offered("yast.scriptExecute", "View"));
        assert.ok(!offered("yast.scriptCreate", "Table"), "tables have the submenu instead");
        assert.ok(offered("yast.scriptDatabase", "Database"));
        assert.ok(!offered("yast.scriptDatabase", "Table"));
    });
});

/** Runs SQL directly on the test database, beside the extension (objects for the tests). */
async function runDirectly(provider: TestProfile["provider"], text: string): Promise<string[][]> {
    const p = profile(provider);
    if (provider === "pg") {
        const client = new Client({
            host: p.server,
            port: p.port,
            user: p.user,
            password: p.password,
            database: p.database,
        });
        await client.connect();
        try {
            const result = await client.query({ text, rowMode: "array" });
            return (result.rows ?? []).map((r: unknown[]) => r.map(String));
        } finally {
            await client.end();
        }
    }
    const [host, port] = p.server.split(",");
    const pool = await new sql.ConnectionPool({
        server: host,
        port: Number(port),
        user: p.user,
        password: p.password,
        database: p.database,
        options: { encrypt: true, trustServerCertificate: true },
    }).connect();
    try {
        const result = await pool.request().batch(text);
        return (result.recordset ?? []).map((r: Record<string, unknown>) =>
            Object.values(r).map(String),
        );
    } finally {
        await pool.close();
    }
}

/** Picks the entry of the open quick pick whose label starts with `label`. */
async function pick(label: string): Promise<void> {
    const items = await waitFor(`"${label}" in the quick pick`, quickPickItems, (list) =>
        list.some((item) => item.startsWith(label)),
    );
    for (let i = items.findIndex((item) => item.startsWith(label)); i > 0; i--) {
        await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
    }
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
}

/** Types a path into the simple save dialog (files.simpleDialog.enable) and accepts it. */
async function fillSaveDialog(file: string): Promise<void> {
    const inputValue = () =>
        inWorkbench<string | null>(`(() => {
            const widget = document.querySelector(".quick-input-widget");
            const input = widget?.querySelector(".quick-input-box input");
            return widget && widget.style.display !== "none" && input ? input.value : null;
        })()`);
    await waitFor("the save dialog", inputValue, (value) => !!value);
    // The dialog fills its box once it has listed the folder: type until the path stays there.
    await waitFor(
        "the path typed in the save dialog",
        async () => {
            await inWorkbench(`(() => {
                const input = document.querySelector(".quick-input-widget .quick-input-box input");
                input.focus();
                input.select();
            })()`);
            await (await workbench()).send("Input.insertText", { text: file });
            await sleep(300);
            return inputValue();
        },
        (value) => value === file,
    );
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await waitFor("the save dialog to close", inputValue, (value) => value === null);
}

/** The new untitled SQL editor a scripting command opens. */
async function newScriptEditor(
    previous: vscode.TextEditor | undefined,
): Promise<vscode.TextEditor> {
    const editor = await waitFor(
        "a new SQL editor with the script",
        () => vscode.window.activeTextEditor,
        (e) => !!e && e !== previous && e.document.isUntitled && e.document.getText().length > 0,
    );
    assert.strictEqual(editor!.document.languageId, "sql");
    return editor!;
}

function scriptAsOn(provider: TestProfile["provider"]): void {
    describe(`Script as and Generate Scripts on ${provider}`, () => {
        const { profileName, database } = profile(provider);
        const mssql = provider === "mssql";
        const databasePath = [profileName, "Databases", database];
        const schemaPath = mssql ? databasePath : [...databasePath, "Schemas", "public"];
        const tablePath = [...schemaPath, "Tables", mssql ? "dbo.customers" : "customers"];
        const viewPath = [...schemaPath, "Views", mssql ? "dbo.e2e_view" : "e2e_view"];
        const procedurePath = mssql
            ? [...databasePath, "Programmability", "Stored Procedures", "dbo.e2e_proc"]
            : [...schemaPath, "Procedures", "e2e_proc(IN n integer)"];

        /** Runs a scripting command on the node of `nodePath` and returns the editor it opens. */
        async function scriptAs(command: string, nodePath: string[]): Promise<vscode.TextEditor> {
            await walkTo(nodePath);
            const previous = vscode.window.activeTextEditor;
            await vscode.commands.executeCommand(command);
            return newScriptEditor(previous);
        }

        const closeEditor = () =>
            vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

        before(async () => {
            await runDirectly(
                provider,
                mssql
                    ? "CREATE VIEW dbo.e2e_view AS SELECT 1 AS one"
                    : "CREATE VIEW public.e2e_view AS SELECT 1 AS one",
            );
            await runDirectly(
                provider,
                mssql
                    ? "CREATE PROCEDURE dbo.e2e_proc @n int AS SELECT @n AS n"
                    : "CREATE PROCEDURE public.e2e_proc(IN n integer) LANGUAGE sql AS $$ SELECT 1 $$",
            );
            await vscode.commands.executeCommand("yastObjectExplorer.focus");
        });

        after(async () => {
            await runDirectly(
                provider,
                mssql
                    ? "DROP VIEW dbo.e2e_view; DROP PROCEDURE dbo.e2e_proc"
                    : "DROP VIEW public.e2e_view; DROP PROCEDURE public.e2e_proc(integer)",
            );
            await clickRow(profileName);
        });

        it("opens Script as Create of a table in a connected editor, without running it", async () => {
            const editor = await scriptAs("yast.scriptCreate", tablePath);
            const script = editor.document.getText();
            if (mssql) {
                assert.ok(
                    script.startsWith(
                        "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nCREATE TABLE [dbo].[customers](\n\t[id] [int] IDENTITY(1,1) NOT NULL,",
                    ),
                    script,
                );
                assert.ok(
                    script.endsWith(
                        "ALTER TABLE [dbo].[customers] ADD  DEFAULT (sysutcdatetime()) FOR [created_at]\nGO\n",
                    ),
                    script,
                );
            } else {
                assert.ok(script.startsWith("CREATE SEQUENCE public.customers_id_seq\n"), script);
                assert.ok(script.includes("\nCREATE TABLE public.customers (\n"), script);
                assert.ok(
                    script.includes("ADD CONSTRAINT customers_pkey PRIMARY KEY (id);"),
                    script,
                );
            }
            const titles = await waitFor(
                "the CodeLenses of the connection",
                () => codeLensTitles(editor.document.uri),
                (t) => t.length === 3,
            );
            assert.ok(titles[0].includes(profileName), JSON.stringify(titles));
            assert.ok(titles[2].includes(database), JSON.stringify(titles));
            await closeEditor();
        });

        it("opens Script as Drop of a table without running it", async () => {
            const editor = await scriptAs("yast.scriptDelete", tablePath);
            assert.strictEqual(
                editor.document.getText(),
                mssql
                    ? "IF  EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[customers]') AND type in (N'U'))\nDROP TABLE [dbo].[customers]\nGO\n"
                    : "DROP TABLE IF EXISTS public.customers;\n",
            );
            await closeEditor();
            // Not run: the table is still there.
            const count = await runDirectly(provider, "SELECT count(*) FROM customers");
            assert.deepStrictEqual(count, [["3"]]);
        });

        it("opens Script as Alter of a view", async () => {
            const editor = await scriptAs("yast.scriptAlter", viewPath);
            assert.strictEqual(
                editor.document.getText(),
                mssql
                    ? "SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nALTER VIEW dbo.e2e_view AS SELECT 1 AS one\nGO\n"
                    : "CREATE OR REPLACE VIEW public.e2e_view AS\n SELECT 1 AS one;\n",
            );
            await closeEditor();
        });

        it("opens Script as Execute of a stored procedure", async () => {
            const editor = await scriptAs("yast.scriptExecute", procedurePath);
            assert.strictEqual(
                editor.document.getText(),
                mssql
                    ? "DECLARE @RC int\nDECLARE @n int\n\n-- TODO: Set parameter values here.\n\nEXECUTE @RC = [dbo].[e2e_proc] \n   @n\nGO"
                    : "-- TODO: Set parameter values here.\n\nCALL public.e2e_proc(\n    n => NULL::integer\n);\n",
            );
            await closeEditor();
            assert.deepStrictEqual(await errorNotifications(), []);
        });

        it("generates the schema of the database into a connected editor", async () => {
            await walkTo(databasePath);
            const previous = vscode.window.activeTextEditor;
            const done = vscode.commands.executeCommand("yast.scriptDatabase");
            await pick("Schema only");
            await pick("Open in a new query editor");
            await done;
            const editor = await newScriptEditor(previous);
            const script = editor.document.getText();
            assert.ok(
                script.includes(
                    mssql ? "CREATE TABLE [dbo].[orders](" : "CREATE TABLE public.orders (",
                ),
                script,
            );
            assert.ok(!/^INSERT /m.test(script), "schema only, but there are INSERT statements");
            const titles = await waitFor(
                "the CodeLenses of the connection",
                () => codeLensTitles(editor.document.uri),
                (t) => t.length === 3,
            );
            assert.ok(titles[2].includes(database), JSON.stringify(titles));
            await closeEditor();
        });

        it("generates the schema and the data of the database into a file", async () => {
            const file = path.join(
                os.tmpdir(),
                `yast-e2e-${provider}-${randomBytes(4).toString("hex")}.sql`,
            );
            try {
                await walkTo(databasePath);
                const done = vscode.commands.executeCommand("yast.scriptDatabase");
                await pick("Schema and data");
                await pick("Save to file...");
                await fillSaveDialog(file);
                // The command ends when its "Script saved" notification is answered.
                const saved = await waitFor(
                    "the saved notification",
                    () =>
                        inWorkbench<string[]>(
                            `[...document.querySelectorAll(".notifications-toasts .notification-list-item-message")].map((m) => m.textContent)`,
                        ),
                    (messages) => messages.some((m) => m.includes(path.basename(file))),
                    60000,
                );
                assert.ok(saved.length > 0);
                await vscode.commands.executeCommand("notifications.clearAll");
                await done;
                const script = fs.readFileSync(file, "utf8");
                assert.ok(
                    script.includes(
                        mssql
                            ? "CREATE TABLE [dbo].[customers]("
                            : "CREATE TABLE public.customers (",
                    ),
                );
                assert.ok(
                    script.includes(
                        mssql
                            ? "INSERT [dbo].[customers] ([id], [name], [email], [created_at]) VALUES (3, N'Chloé', N'chloe@example.com', "
                            : "INSERT INTO public.customers (id, name, email, created_at) VALUES (3, 'Chloé', 'chloe@example.com', ",
                    ),
                    script,
                );
                assert.deepStrictEqual(await errorNotifications(), []);
            } finally {
                fs.rmSync(file, { force: true });
                await vscode.commands.executeCommand("notifications.clearAll");
            }
        });
    });
}

scriptAsOn("mssql");
scriptAsOn("pg");

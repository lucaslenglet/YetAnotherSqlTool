// The webview dialogs, then what every webview opened during the run reported: a bundle or an
// asset missing from the package, or blocked by the Content Security Policy, shows up there.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import * as vscode from "vscode";
import { allSessions, findWebviews, jsLiteral, Session, workbench, type Webview } from "./cdp";
import { env, profile } from "./env";
import {
    codeLensTitles,
    errorNotifications,
    objectExplorerRows,
    pickFromCommand,
    sleep,
    waitFor,
    waitForWebview,
} from "./helpers";

function webviewTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputWebview);
}

/** Finds the control of a form field from the text of its label. To paste in front of an expression. */
const control = `const control = (label) => {
    const found = [...document.querySelectorAll("label")].find((l) => l.textContent.replace("*", "").trim() === label);
    return found ? document.getElementById(found.htmlFor) : null;
};`;

/** Types a value into the text field with this label, the way React sees a user typing. */
async function fill(webview: Webview, label: string, value: string): Promise<void> {
    const filled = await webview.evaluate<boolean>(`(() => {
        ${control}
        const input = control(${jsLiteral(label)});
        if (!input) return false;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, ${jsLiteral(value)});
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        return input.value === ${jsLiteral(value)};
    })()`);
    assert.ok(filled, `Could not fill the "${label}" field`);
}

/** Ticks the checkbox with this label. Its state comes back from the extension: wait for it. */
async function check(webview: Webview, label: string): Promise<void> {
    const box = `(() => { ${control} return control(${jsLiteral(label)}); })()`;
    assert.ok(await webview.evaluate<boolean>(`!!${box}`), `The dialog has no "${label}" checkbox`);
    await webview.evaluate(`${box}.checked || ${box}.click()`);
    await waitFor(`"${label}" to be checked`, () => webview.evaluate<boolean>(`${box}.checked`));
}

/** Picks an option of the dropdown with this label, by the text it shows. */
async function pick(webview: Webview, label: string, option: string): Promise<void> {
    await webview.evaluate(`(() => { ${control} control(${jsLiteral(label)}).click(); })()`);
    const clicked = await waitFor(`the "${option}" option of "${label}"`, () =>
        webview.evaluate<boolean>(`(() => {
            const found = [...document.querySelectorAll('[role="option"]')]
                .find((o) => o.textContent.trim() === ${jsLiteral(option)});
            if (!found) return false;
            found.click();
            return true;
        })()`),
    );
    assert.ok(clicked);
}

describe("Webviews", () => {
    // Created with the connection dialog, from the SQL Server profile of the settings.
    const dialogProfileName = "Created in the dialog";

    after(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("opens the connection dialog", async () => {
        await vscode.commands.executeCommand("yast.addObjectExplorer");
        const webview = await waitForWebview(
            "connectionDialog",
            `document.querySelector("#connectButton")`,
        );
        assert.strictEqual(webviewTabs().length, 1);
        const text = await webview.text();
        for (const label of [
            "Profile Name",
            "Server name",
            "Authentication type",
            "Saved Connections",
        ]) {
            assert.ok(text.includes(label), `"${label}" is not in the connection dialog:\n${text}`);
        }
        // The saved connections are listed next to the form.
        assert.ok(text.includes(profile("pg").profileName));
    });

    it("offers Windows Authentication, which asks for a DOMAIN\\user and a password", async () => {
        const webview = await waitForWebview(
            "connectionDialog",
            `document.querySelector("#connectButton")`,
        );
        const has = (label: string) =>
            webview.evaluate<boolean>(
                `(() => { ${control} return !!control(${jsLiteral(label)}); })()`,
            );

        await pick(webview, "Authentication type", "Windows Authentication");

        await waitFor("the user name and password fields", async () => {
            return (
                (await has("User name")) && (await has("Password")) && (await has("Save Password"))
            );
        });
        const placeholder = await webview.evaluate<string>(
            `(() => { ${control} return control("User name").placeholder; })()`,
        );
        assert.strictEqual(placeholder, "DOMAIN\\user");

        // Back to SQL Login for the next test, which fills the same form.
        await pick(webview, "Authentication type", "SQL Login");
        await waitFor("the SQL Login form", async () => {
            const back = await webview.evaluate<string>(
                `(() => { ${control} return control("User name")?.placeholder ?? null; })()`,
            );
            return back === "";
        });
    });

    it("connects from the dialog and saves the profile, its password in SecretStorage", async () => {
        const { server, user, password } = profile("mssql");
        const webview = await waitForWebview(
            "connectionDialog",
            `document.querySelector("#connectButton")`,
        );
        await fill(webview, "Profile Name", dialogProfileName);
        await fill(webview, "Server name", server);
        await check(webview, "Trust server certificate");
        await fill(webview, "User name", user);
        await fill(webview, "Password", password);
        await check(webview, "Save Password");
        await waitFor("the Connect button to be enabled", () =>
            webview.evaluate<boolean>(`!document.querySelector("#connectButton").disabled`),
        );
        await webview.evaluate(`document.querySelector("#connectButton").click()`);

        // The dialog closes once connected.
        await waitFor(
            "the connection dialog to close",
            () => webviewTabs().length === 0,
            Boolean,
            40000,
        );
        assert.deepStrictEqual(await errorNotifications(), []);

        const saved = vscode.workspace
            .getConfiguration("yast")
            .get<Record<string, unknown>[]>("connections", [])
            .find((p) => p.profileName === dialogProfileName);
        assert.ok(saved, "the profile is not in the settings");
        assert.strictEqual(saved.server, server);
        assert.strictEqual(saved.savePassword, true);
        assert.ok(!saved.password, "the password must not be written to the settings");

        await waitFor(
            "the new connection in the Object Explorer",
            async () => (await objectExplorerRows()).map((row) => row.label),
            (labels) => labels.includes(dialogProfileName),
        );
    });

    it("connects a new query editor with the password read from SecretStorage", async () => {
        // "New Query" opens an editor, then the connection quick pick.
        await pickFromCommand("yast.newQuery", dialogProfileName);
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, "New Query did not open an editor");
        assert.strictEqual(editor.document.languageId, "sql");
        const titles = await waitFor(
            "the CodeLenses of the connection",
            () => codeLensTitles(editor.document.uri),
            (t) => t.length === 3,
        );
        assert.ok(titles[0].includes(dialogProfileName), JSON.stringify(titles));
        assert.deepStrictEqual(await errorNotifications(), []);
    });

    it("shows the results of that editor in a tab of their own", async () => {
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, "the editor of the previous test is gone");
        const marker = "shown in a results tab";
        assert.ok(
            await editor.edit((edit) =>
                edit.insert(new vscode.Position(0, 0), `SELECT '${marker}' AS marker;`),
            ),
        );
        await vscode.commands.executeCommand("yast.runQuery");

        const view = await waitForWebview(
            "queryResult",
            `document.body.innerText.includes("${marker}")`,
        );
        const clicked = await view.evaluate<boolean>(`(() => {
            const button = document.querySelector('button[title="Open in New Tab"]');
            button?.click();
            return !!button;
        })()`);
        assert.ok(clicked, 'The results view has no "Open in New Tab" button');

        await waitFor("the results tab", () => webviewTabs().length === 1);
        await waitFor("the rows in the results tab", async () => {
            for (const webview of await findWebviews("queryResult")) {
                // The view of the bottom panel is a webview of the same page.
                if (
                    !webview.session.target.url.includes("purpose=webviewView") &&
                    (await webview.text()).includes(marker)
                ) {
                    return true;
                }
            }
            return false;
        });

        // Untitled and modified: closing it any other way would ask whether to save it.
        await vscode.window.showTextDocument(editor.document, editor.viewColumn);
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    });

    it("opens the connection group dialog", async () => {
        await vscode.commands.executeCommand("yast.connectionGroups.create");
        const webview = await waitForWebview("connectionGroup", `document.querySelector("input")`);
        assert.match(await webview.text(), /Name/);
    });

    it("no webview reported a script error, a blocked resource or a failed load", () => {
        const webviews = allSessions().filter((session) =>
            session.target.url.startsWith("vscode-webview://"),
        );
        // At least the results view, the connection dialog and the connection group dialog.
        assert.ok(webviews.length >= 3, `only ${webviews.length} webview(s) were observed`);
        assert.deepStrictEqual(
            webviews.flatMap((session) => session.errors),
            [],
        );
    });

    it("the window logged no error about the extension", async () => {
        const errors = (await workbench()).errors.filter((e) =>
            e.toLowerCase().includes(env.extensionId),
        );
        assert.deepStrictEqual(errors, []);
    });

    // Last, since it makes a webview fail on purpose: proves that the check above is not blind,
    // including to what happened before a debugging session was attached.
    it("such errors would have been seen", async () => {
        const webview = await waitForWebview("connectionGroup");
        await webview.evaluate(`(() => {
            console.error("selfcheck-console");
            window.setTimeout(() => { throw new Error("selfcheck-uncaught"); }, 0);
            // Not from the extension folder: refused by the Content Security Policy.
            const image = document.createElement("img");
            image.src = "https://example.invalid/selfcheck-blocked.png";
            // From the extension folder, but not in the package.
            const script = document.createElement("script");
            script.src = "selfcheck-missing.js";
            document.body.append(image, script);
            return true;
        })()`);
        const late = await Session.attach(webview.session.target);
        try {
            await waitFor(
                "the errors provoked in the webview",
                () => late.errors,
                (errors) =>
                    [
                        "selfcheck-console",
                        "selfcheck-uncaught",
                        "selfcheck-blocked.png",
                        "selfcheck-missing.js",
                    ].every((marker) => errors.some((error) => error.includes(marker))),
            );
        } finally {
            late.close();
        }
    });
});

// A server with many databases: the "Database name" list is far taller than the window, so it fits
// on no side of the field. Fluent's autoSize then resized it on every placement and it jumped
// between sides; the list is now a fixed 300 px box that scrolls.
describe("The Database name list of the connection dialog, on a server with many databases", () => {
    const databaseCount = 80;
    const names = Array.from(
        { length: databaseCount },
        (_, i) => `yast_e2e_dblist_${String(i).padStart(3, "0")}`,
    );
    const lastName = names[names.length - 1];
    const pg = profile("pg");

    const connect = async <T>(use: (client: Client) => Promise<T>): Promise<T> => {
        const client = new Client({
            host: pg.server,
            port: pg.port,
            user: pg.user,
            password: pg.password,
            database: pg.database,
        });
        await client.connect();
        try {
            return await use(client);
        } finally {
            await client.end();
        }
    };

    before(async function () {
        this.timeout(120000);
        await connect(async (client) => {
            for (const name of names) {
                await client.query(`CREATE DATABASE "${name}"`);
            }
        });
    });

    after(async function () {
        this.timeout(120000);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await connect(async (client) => {
            for (const name of names) {
                await client.query(`DROP DATABASE IF EXISTS "${name}"`);
            }
        });
    });

    /** Finds the open list of the Database name field: other dropdowns of the form may be open too. */
    const listOf = `${control}
        const listbox = () => {
            const id = control("Database name")?.getAttribute("aria-controls");
            return id ? document.getElementById(id) : null;
        };`;

    /** Box of the open list, and what it holds. Null while no list is open. */
    const listbox = (webview: Webview) =>
        webview.evaluate<{
            left: number;
            top: number;
            width: number;
            height: number;
            scrollHeight: number;
            clientHeight: number;
            windowHeight: number;
        } | null>(`(() => {
            ${listOf}
            const list = listbox();
            if (!list) return null;
            const box = list.getBoundingClientRect();
            return {
                left: box.left, top: box.top, width: box.width, height: box.height,
                scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
                windowHeight: window.innerHeight,
            };
        })()`);

    it("opens at most 300 px high, scrolls to the last database and stays where it is", async function () {
        this.timeout(120000);
        await vscode.commands.executeCommand("yast.addObjectExplorer");
        const webview = await waitForWebview(
            "connectionDialog",
            `document.querySelector("#connectButton")`,
        );
        await pick(webview, "Database type", "PostgreSQL");
        // The form is rebuilt for the engine: its port field is the one that tells.
        await waitFor("the PostgreSQL form", () =>
            webview.evaluate<boolean>(
                `(() => { ${control} return control("Port")?.placeholder === "5432"; })()`,
            ),
        );
        await fill(webview, "Server name", pg.server);
        await fill(webview, "Port", String(pg.port));
        await fill(webview, "User name", pg.user);
        await fill(webview, "Password", pg.password);
        // The databases are read when a text field loses the focus, not on every keystroke.
        await webview.evaluate(`(() => {
            ${control}
            control("Password").dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
            return true;
        })()`);

        // The list fills in once the databases are read; the options exist only while it is open.
        const openList = `(() => {
            ${listOf}
            const input = control("Database name");
            if (!listbox()) input.click();
            return [...(listbox()?.querySelectorAll('[role="option"]') ?? [])].map((o) => o.textContent.trim());
        })()`;
        await waitFor(
            `"${lastName}" in the Database name list`,
            () => webview.evaluate<string[]>(openList),
            (options) => !!options && options.includes(lastName),
            40000,
        );
        // Let the placement settle: it takes a few frames.
        await sleep(500);

        const first = await listbox(webview);
        assert.ok(first, "the list is not open");
        assert.ok(
            first.scrollHeight > first.windowHeight,
            `the list is too short to test anything: ${first.scrollHeight} px of content in a ${first.windowHeight} px window`,
        );

        // Where the list is, for about a second: every frame, to catch a jump.
        const samples = await webview.evaluate<string[]>(`new Promise((resolve) => {
            ${listOf}
            const seen = [];
            const end = Date.now() + 1000;
            const sample = () => {
                const box = listbox()?.getBoundingClientRect();
                seen.push(box ? [box.left, box.top, box.width, box.height].join(",") : "closed");
                if (Date.now() < end) setTimeout(sample, 16);
                else resolve(seen);
            };
            sample();
        })`);
        assert.ok(samples && samples.length > 10, `only ${samples?.length} samples`);

        // A real screenshot of the window, to look at when this fails.
        const shot = await (
            await workbench()
        ).send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
        });
        fs.writeFileSync(
            path.join(env.artifactsDir, "database-list-open.png"),
            Buffer.from(shot.data, "base64"),
        );

        assert.ok(
            first.height <= 300,
            `the list is ${first.height} px high; ${first.scrollHeight} px of content in a ${first.windowHeight} px window`,
        );
        assert.ok(
            first.scrollHeight > first.clientHeight,
            `the list does not scroll: ${first.scrollHeight} px of content in a ${first.clientHeight} px box`,
        );
        assert.deepStrictEqual(
            [...new Set(samples)],
            [`${first.left},${first.top},${first.width},${first.height}`],
            "the list moved or changed size while open",
        );

        // The last database is reachable by scrolling, and it is what the user sees there: the
        // option itself is on top at its position, inside the box of the list.
        const reached = await webview.evaluate<{
            scrolled: boolean;
            optionTop: number;
            optionBottom: number;
            listTop: number;
            listBottom: number;
            onTop: boolean;
        }>(`(() => {
            ${listOf}
            const list = listbox();
            const option = [...list.querySelectorAll('[role="option"]')]
                .find((o) => o.textContent.trim() === ${jsLiteral(lastName)});
            list.scrollTop = list.scrollHeight;
            const box = option.getBoundingClientRect();
            const listBox = list.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return {
                scrolled: list.scrollTop > 0,
                optionTop: box.top, optionBottom: box.bottom,
                listTop: listBox.top, listBottom: listBox.bottom,
                onTop: !!hit && option.contains(hit),
            };
        })()`);
        assert.ok(reached);
        assert.ok(reached.scrolled, "the list did not scroll");
        assert.ok(
            reached.optionTop >= reached.listTop - 1 &&
                reached.optionBottom <= reached.listBottom + 1,
            `the last database is outside the list: ${JSON.stringify(reached)}`,
        );
        assert.ok(
            reached.onTop,
            `the last database is hidden behind something: ${JSON.stringify(reached)}`,
        );

        // And it can be picked.
        await webview.evaluate(`(() => {
            ${listOf}
            [...listbox().querySelectorAll('[role="option"]')]
                .find((o) => o.textContent.trim() === ${jsLiteral(lastName)}).click();
            return true;
        })()`);
        await waitFor(
            "the picked database in the field",
            () =>
                webview.evaluate<string>(
                    `(() => { ${control} return control("Database name").value; })()`,
                ),
            (value) => value === lastName,
        );
    });
});

// The webview dialogs, then what every webview opened during the run reported: a bundle or an
// asset missing from the package, or blocked by the Content Security Policy, shows up there.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { allSessions, findWebviews, Session, workbench, type Webview } from "./cdp";
import { env, profile } from "./env";
import {
    codeLensTitles,
    errorNotifications,
    objectExplorerRows,
    pickFromCommand,
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
        const input = control(${JSON.stringify(label)});
        if (!input) return false;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        return input.value === ${JSON.stringify(value)};
    })()`);
    assert.ok(filled, `Could not fill the "${label}" field`);
}

/** Ticks the checkbox with this label. Its state comes back from the extension: wait for it. */
async function check(webview: Webview, label: string): Promise<void> {
    const box = `(() => { ${control} return control(${JSON.stringify(label)}); })()`;
    assert.ok(await webview.evaluate<boolean>(`!!${box}`), `The dialog has no "${label}" checkbox`);
    await webview.evaluate(`${box}.checked || ${box}.click()`);
    await waitFor(`"${label}" to be checked`, () => webview.evaluate<boolean>(`${box}.checked`));
}

/** Picks an option of the dropdown with this label, by the text it shows. */
async function pick(webview: Webview, label: string, option: string): Promise<void> {
    await webview.evaluate(`(() => { ${control} control(${JSON.stringify(label)}).click(); })()`);
    const clicked = await waitFor(`the "${option}" option of "${label}"`, () =>
        webview.evaluate<boolean>(`(() => {
            const found = [...document.querySelectorAll('[role="option"]')]
                .find((o) => o.textContent.trim() === ${JSON.stringify(option)});
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
                `(() => { ${control} return !!control(${JSON.stringify(label)}); })()`,
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

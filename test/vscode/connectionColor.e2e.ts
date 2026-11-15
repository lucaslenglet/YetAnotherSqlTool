// The color of a connection: the status bar items and a strip along the left edge of a SQL editor
// connected with a colored profile, as the user sees them, then the Color field of the connection
// dialog. The suite changes the saved connections and puts them back at the end.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { jsLiteral, type Webview } from "./cdp";
import { env, profile } from "./env";
import {
    errorNotifications,
    extension,
    inWorkbench,
    pickFromCommand,
    statusBarTexts,
    waitFor,
    waitForWebview,
} from "./helpers";

const red = { hex: "#c50f1f", rgb: "rgb(197, 15, 31)" };
const green = { hex: "#107c10", rgb: "rgb(16, 124, 16)" };

type Profiles = Record<string, unknown>[];

function savedConnections(): Profiles {
    return vscode.workspace.getConfiguration("yast").get<Profiles>("connections", []);
}

async function setConnections(profiles: Profiles | undefined): Promise<void> {
    await vscode.workspace
        .getConfiguration("yast")
        .update("connections", profiles, vscode.ConfigurationTarget.Global);
}

/** Sets (or removes, with undefined) the color of a saved profile in the user settings. */
async function setColor(id: string, color: string | undefined): Promise<void> {
    await setConnections(
        savedConnections().map((p) => {
            if (p.id !== id) return p;
            const { color: _previous, ...rest } = p;
            return color ? { ...rest, color } : rest;
        }),
    );
}

/** Computed text color of the visible status bar items of the extension, with their text. */
function statusBarColors(): Promise<{ text: string; color: string }[]> {
    return inWorkbench(`[...document.querySelectorAll('.statusbar-item[id^="${env.extensionId}" i]')]
        .filter((item) => item.offsetParent !== null)
        .map((item) => {
            const label = item.querySelector("a") ?? item;
            return { text: item.textContent, color: getComputedStyle(label).color };
        })`);
}

/**
 * The colored strips Monaco draws in the visible editors: the elements of the line overlays
 * that have a 3px left border, with its color and their line count per editor.
 */
function editorStrips(): Promise<{ editors: number; lines: number[]; colors: string[] }> {
    return inWorkbench(`(() => {
        const editors = [...document.querySelectorAll(".editor-instance .monaco-editor")]
            .filter((e) => e.offsetParent !== null);
        const lines = [];
        const colors = new Set();
        for (const editor of editors) {
            let count = 0;
            for (const el of editor.querySelectorAll(".view-overlays > div > div")) {
                const style = getComputedStyle(el);
                if (style.borderLeftWidth === "3px" && style.borderLeftStyle === "solid") {
                    count++;
                    colors.add(style.borderLeftColor);
                }
            }
            lines.push(count);
        }
        return { editors: editors.length, lines, colors: [...colors] };
    })()`);
}

/** Finds the control of a form field from the text of its label. To paste in front of an expression. */
const control = `const control = (label) => {
    const found = [...document.querySelectorAll("label")].find((l) => l.textContent.replace("*", "").trim() === label);
    return found ? document.getElementById(found.htmlFor) : null;
};`;

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

async function check(webview: Webview, label: string): Promise<void> {
    const box = `(() => { ${control} return control(${jsLiteral(label)}); })()`;
    assert.ok(await webview.evaluate<boolean>(`!!${box}`), `The dialog has no "${label}" checkbox`);
    await webview.evaluate(`${box}.checked || ${box}.click()`);
    await waitFor(`"${label}" to be checked`, () => webview.evaluate<boolean>(`${box}.checked`));
}

describe("Connection color", () => {
    const pg = profile("pg");
    let original: Profiles | undefined;
    let editor: vscode.TextEditor;

    before(async () => {
        original = vscode.workspace
            .getConfiguration("yast")
            .inspect<Profiles>("connections")?.globalValue;
        await extension().activate();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await setColor(pg.id, red.hex);
        const document = await vscode.workspace.openTextDocument({
            language: "sql",
            content: "SELECT 1;\nSELECT 2;\nSELECT 3;\n",
        });
        editor = await vscode.window.showTextDocument(document, { preview: false });
    });

    after(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await setConnections(original);
    });

    it("shows nothing on an editor that is not connected", async () => {
        await waitFor("the Connect status bar item", statusBarTexts, (texts) =>
            texts.some((t) => t.includes("Connect")),
        );
        assert.deepStrictEqual((await editorStrips()).colors, []);
    });

    it("colors the status bar and the editor once connected with a colored profile", async () => {
        await pickFromCommand("yast.connect", pg.profileName);

        const items = await waitFor(
            "the connection and database items in red",
            statusBarColors,
            (list) => list.filter((i) => i.color === red.rgb).length === 2,
        );
        assert.ok(
            items.some((i) => i.color === red.rgb && i.text.includes(pg.server)),
            JSON.stringify(items),
        );
        assert.ok(
            items.some((i) => i.color === red.rgb && i.text.includes(pg.database)),
            JSON.stringify(items),
        );
        const strips = await waitFor(
            "the red strip along the editor",
            editorStrips,
            (s) => s.colors.length === 1 && s.lines[0] >= 4,
        );
        assert.deepStrictEqual(strips.colors, [red.rgb]);
        assert.deepStrictEqual(await errorNotifications(), []);
    });

    it("covers the lines added to the document", async () => {
        await editor.edit((edit) =>
            edit.insert(
                new vscode.Position(editor.document.lineCount, 0),
                "SELECT 4;\nSELECT 5;\nSELECT 6;\n",
            ),
        );
        await waitFor(
            "the strip to cover the 7 lines",
            editorStrips,
            (s) => s.lines[0] === editor.document.lineCount,
        );
    });

    it("follows a color changed in the settings, without reconnecting", async () => {
        await setColor(pg.id, green.hex);

        await waitFor(
            "the status bar items in green",
            statusBarColors,
            (list) => list.filter((i) => i.color === green.rgb).length === 2,
        );
        const strips = await waitFor(
            "the green strip",
            editorStrips,
            (s) => s.colors.length === 1 && s.colors[0] === green.rgb,
        );
        assert.ok(strips.lines[0] > 0);
    });

    it("loses the color when the color is removed from the profile", async () => {
        await setColor(pg.id, undefined);
        await waitFor("no strip", editorStrips, (s) => s.colors.length === 0);
        const items = await statusBarColors();
        assert.ok(!items.some((i) => i.color === green.rgb), JSON.stringify(items));
        await setColor(pg.id, red.hex);
        await waitFor("the red strip again", editorStrips, (s) => s.colors[0] === red.rgb);
    });

    it("loses the color when the editor disconnects", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disconnect");

        await waitFor("no strip", editorStrips, (s) => s.colors.length === 0);
        const items = await waitFor("the Connect status bar item", statusBarColors, (list) =>
            list.some((i) => i.text.includes("Connect")),
        );
        assert.ok(!items.some((i) => i.color === red.rgb), JSON.stringify(items));
    });

    it("chooses a color in the connection dialog and saves it with the profile", async () => {
        const mssql = profile("mssql");
        const name = "Colored in the dialog";
        await vscode.commands.executeCommand("yast.addObjectExplorer");
        const webview = await waitForWebview(
            "connectionDialog",
            `document.querySelector("#connectButton") && document.querySelector('button[aria-label="No color"]')`,
        );
        // "No color" is the selection of a new profile; then the palette and "other color".
        const swatches = await webview.evaluate<{ label: string; pressed: string }[]>(
            `[...document.querySelectorAll('[role="group"] button[data-color]')].map((b) => ({
                label: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed") }))`,
        );
        assert.strictEqual(swatches?.length, 12, JSON.stringify(swatches));
        assert.deepStrictEqual(swatches[0], { label: "No color", pressed: "true" });
        assert.ok((await webview.text()).includes("Color"));

        await fill(webview, "Profile Name", name);
        await fill(webview, "Server name", mssql.server);
        await check(webview, "Trust server certificate");
        await fill(webview, "User name", mssql.user);
        await fill(webview, "Password", mssql.password);
        await webview.evaluate(
            `document.querySelector('button[data-color="${green.hex}"]').click()`,
        );
        // The selection comes back from the extension.
        await waitFor("the green swatch to be selected", () =>
            webview.evaluate<boolean>(
                `document.querySelector('button[data-color="${green.hex}"]').getAttribute("aria-pressed") === "true"`,
            ),
        );
        await waitFor("the Connect button to be enabled", () =>
            webview.evaluate<boolean>(`!document.querySelector("#connectButton").disabled`),
        );
        await webview.evaluate(`document.querySelector("#connectButton").click()`);

        const saved = await waitFor(
            "the profile in the settings",
            () => savedConnections().find((p) => p.profileName === name),
            Boolean,
            40000,
        );
        assert.strictEqual(saved?.color, green.hex);
        assert.deepStrictEqual(await errorNotifications(), []);
    });
});

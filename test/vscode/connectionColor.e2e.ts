// The color of a connection: the status bar items and a bar in the gutter of a SQL editor
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

interface GutterBars {
    /** Visible editors. */
    editors: number;
    /** Per editor, the lines that have a color bar. */
    lines: number[];
    /** Per editor, the bars that are on top at their left edge: nothing of the editor covers them. */
    uncovered: number[];
    /** Per editor, whether every bar lies left of the line numbers and of the text. */
    leftOfCode: boolean[];
    /** Colors of the bars (fill of their SVG icon). */
    colors: string[];
}

/**
 * The color bars Monaco draws in the gutter of the visible editors: the margin elements whose
 * background is an SVG data URI. For each one, what is at the point 1px inside its left edge, in
 * the middle of its height, tells whether something (a selection, a highlight...) covers it.
 */
function gutterBars(): Promise<GutterBars> {
    return inWorkbench(`(() => {
        const editors = [...document.querySelectorAll(".editor-instance .monaco-editor")]
            .filter((e) => e.offsetParent !== null);
        const result = { editors: editors.length, lines: [], uncovered: [], leftOfCode: [], colors: [] };
        const colors = new Set();
        for (const editor of editors) {
            const lineNumbers = [...editor.querySelectorAll(".line-numbers")]
                .map((n) => n.getBoundingClientRect().left);
            const code = editor.querySelector(".lines-content")?.getBoundingClientRect().left ?? Infinity;
            const firstNumber = lineNumbers.length ? Math.min(...lineNumbers) : Infinity;
            let count = 0, uncovered = 0, left = true;
            for (const el of editor.querySelectorAll(".margin *")) {
                const background = getComputedStyle(el).backgroundImage;
                const start = background.indexOf("data:image/svg+xml;base64,");
                if (start < 0) continue;
                const svg = atob(background.slice(start + 26).split(/["')]/)[0]);
                const fill = svg.split('fill="')[1];
                if (fill) colors.add(fill.slice(0, 7).toLowerCase());
                count++;
                const box = el.getBoundingClientRect();
                // The sash between the side bar and the editors may lie over the edge: it is
                // transparent until hovered.
                const top = document.elementsFromPoint(box.left + 1, box.top + box.height / 2)
                    .find((e) => !e.classList.contains("monaco-sash"));
                if (top === el) uncovered++;
                if (box.left + 3 > firstNumber || box.left + 3 > code) left = false;
            }
            result.lines.push(count);
            result.uncovered.push(uncovered);
            result.leftOfCode.push(left);
        }
        result.colors = [...colors];
        return result;
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
        // At activation the extension writes the profiles back with their group: changing them
        // before that would be lost when this suite runs first.
        await waitFor("the profiles to have their group", () =>
            savedConnections().every((p) => p.groupId),
        );
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
        assert.deepStrictEqual((await gutterBars()).colors, []);
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
        const bars = await waitFor(
            "the red bar in the gutter of the editor",
            gutterBars,
            (b) => b.colors.length === 1 && b.lines[0] === editor.document.lineCount,
        );
        assert.deepStrictEqual(bars.colors, [red.hex]);
        assert.deepStrictEqual(bars.uncovered, bars.lines, JSON.stringify(bars));
        assert.deepStrictEqual(bars.leftOfCode, [true], JSON.stringify(bars));
        assert.deepStrictEqual(await errorNotifications(), []);
    });

    it("keeps the bar visible when every line is selected or a word at column 0 is highlighted", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("editor.action.selectAll");
        await waitFor("the selection to be drawn", () =>
            inWorkbench<boolean>(`!!document.querySelector(".editor-instance .selected-text")`),
        );
        let bars = await gutterBars();
        assert.strictEqual(bars.lines[0], editor.document.lineCount, JSON.stringify(bars));
        assert.deepStrictEqual(bars.uncovered, bars.lines, JSON.stringify(bars));
        assert.deepStrictEqual(bars.colors, [red.hex]);

        // The cursor in "SELECT" highlights its other occurrences, all at column 0.
        editor.selection = new vscode.Selection(0, 2, 0, 2);
        await waitFor("the occurrences of SELECT to be highlighted", () =>
            inWorkbench<number>(
                `document.querySelectorAll(".editor-instance .wordHighlightText, .editor-instance .wordHighlight, .editor-instance .wordHighlightStrong").length`,
            ),
        );
        bars = await gutterBars();
        assert.deepStrictEqual(bars.uncovered, bars.lines, JSON.stringify(bars));
        assert.deepStrictEqual(bars.leftOfCode, [true], JSON.stringify(bars));
    });

    it("covers the lines added to the document", async () => {
        await editor.edit((edit) =>
            edit.insert(
                new vscode.Position(editor.document.lineCount, 0),
                "SELECT 4;\nSELECT 5;\nSELECT 6;\n",
            ),
        );
        await waitFor(
            "the bar to cover the 7 lines",
            gutterBars,
            (b) => b.lines[0] === editor.document.lineCount,
        );
    });

    it("follows a color changed in the settings, without reconnecting", async () => {
        await setColor(pg.id, green.hex);

        await waitFor(
            "the status bar items in green",
            statusBarColors,
            (list) => list.filter((i) => i.color === green.rgb).length === 2,
        );
        const bars = await waitFor(
            "the green bar",
            gutterBars,
            (b) => b.colors.length === 1 && b.colors[0] === green.hex,
        );
        assert.ok(bars.lines[0] > 0);
    });

    it("loses the color when the color is removed from the profile", async () => {
        await setColor(pg.id, undefined);
        await waitFor("no bar", gutterBars, (b) => b.colors.length === 0);
        const items = await statusBarColors();
        assert.ok(!items.some((i) => i.color === green.rgb), JSON.stringify(items));
        await setColor(pg.id, red.hex);
        await waitFor("the red bar again", gutterBars, (b) => b.colors[0] === red.hex);
    });

    it("loses the color when the editor disconnects", async () => {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand("yast.disconnect");

        await waitFor("no bar", gutterBars, (b) => b.colors.length === 0);
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

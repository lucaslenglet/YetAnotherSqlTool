// Helpers shared by the suites: waiting, and reading what the workbench shows.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { allSessions, findWebviews, Webview, workbench } from "./cdp";
import { env } from "./env";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `read` until `accept` likes its value, and returns that value. Fails with `what` and the
 * last value read after `timeout` ms.
 */
export async function waitFor<T>(
    what: string,
    read: () => T | PromiseLike<T>,
    accept: (value: T) => boolean = Boolean,
    timeout = 20000,
): Promise<T> {
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    let lastError: unknown;
    for (;;) {
        try {
            last = await read();
            lastError = undefined;
            if (accept(last)) {
                return last;
            }
        } catch (error) {
            lastError = error;
        }
        if (Date.now() > deadline) {
            const seen = lastError
                ? `last error: ${lastError}`
                : `last value: ${JSON.stringify(last)}`;
            assert.fail(`Timed out after ${timeout} ms waiting for ${what} (${seen})`);
        }
        await sleep(100);
    }
}

export function extension(): vscode.Extension<unknown> {
    const found = vscode.extensions.getExtension(env.extensionId);
    assert.ok(found, `${env.extensionId} is not installed in the test instance`);
    return found;
}

/** Titles of the CodeLenses of a document: the extension shows the editor's connection there. */
export async function codeLensTitles(uri: vscode.Uri): Promise<string[]> {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri,
    );
    return (lenses ?? []).map((lens) => lens.command?.title ?? "");
}

// -- the workbench, as the user sees it ------------------------------------------------------

/** Evaluates an expression in the window of VS Code and returns its value. */
export async function inWorkbench<T>(expression: string): Promise<T> {
    return (await workbench()).evaluate<T>(expression);
}

/** Labels of the entries of the quick pick that is open; empty when none is. */
export function quickPickItems(): Promise<string[]> {
    return inWorkbench(`(() => {
        const widget = document.querySelector(".quick-input-widget");
        if (!widget || widget.style.display === "none") return [];
        return [...widget.querySelectorAll(".quick-input-list .monaco-list-row")].map(
            (row) => row.getAttribute("aria-label") || row.textContent);
    })()`);
}

/** Opens the quick pick of a command and picks the entry whose label starts with `label`. */
export async function pickFromCommand(command: string, label: string): Promise<void> {
    const done = vscode.commands.executeCommand(command);
    const items = await waitFor(
        `"${label}" in the quick pick of ${command}`,
        quickPickItems,
        (list) => list.some((item) => item.startsWith(label)),
    );
    // The first entry is the selected one when a quick pick opens.
    for (let i = items.findIndex((item) => item.startsWith(label)); i > 0; i--) {
        await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
    }
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await done;
}

/** Texts of the status bar items of the extension that are visible. */
export function statusBarTexts(): Promise<string[]> {
    return inWorkbench(`[...document.querySelectorAll('.statusbar-item[id^="${env.extensionId}" i]')]
        .filter((item) => item.offsetParent !== null)
        .map((item) => item.textContent)`);
}

/** Messages of the error notifications on screen. */
export function errorNotifications(): Promise<string[]> {
    return inWorkbench(`[...document.querySelectorAll(".notifications-toasts .notification-list-item")]
        .filter((item) => item.querySelector(".codicon-error"))
        .map((item) => item.querySelector(".notification-list-item-message")?.textContent ?? item.textContent)`);
}

/** Rows of the Object Explorer tree that are rendered, top to bottom. */
export function objectExplorerRows(): Promise<
    { label: string; level: number; expanded: string | null; x: number; y: number }[]
> {
    return inWorkbench(`[...document.querySelectorAll(
            '[id="workbench.view.extension.yastObjectExplorerContainer"] .monaco-list-row')]
        .map((row) => {
            const box = row.getBoundingClientRect();
            return {
                label: row.querySelector(".monaco-icon-label")?.textContent ?? row.textContent,
                level: Number(row.getAttribute("aria-level")),
                expanded: row.getAttribute("aria-expanded"),
                x: Math.round(box.left + box.width / 2),
                y: Math.round(box.top + box.height / 2),
            };
        })
        .sort((a, b) => a.y - b.y)`);
}

// -- webviews ---------------------------------------------------------------------------------

/** Waits for a webview of the given bundle whose page satisfies `ready` (an expression). */
export async function waitForWebview(
    bundle: string,
    ready = "true",
    timeout = 30000,
): Promise<Webview> {
    return waitFor(
        `a ${bundle} webview where ${ready}`,
        async () => {
            for (const webview of await findWebviews(bundle)) {
                if (await webview.evaluate<boolean>(`!!(${ready})`)) {
                    return webview;
                }
            }
            return undefined;
        },
        Boolean,
        timeout,
    ) as Promise<Webview>;
}

// -- diagnostics ------------------------------------------------------------------------------

/** Writes the DOM of the workbench and of every webview to the artifacts folder. */
export async function dumpDom(name: string): Promise<void> {
    const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 80);
    const write = (suffix: string, content: string) =>
        fs.writeFileSync(path.join(env.artifactsDir, `${safe}.${suffix}`), content);
    try {
        write("workbench.html", await inWorkbench<string>("document.documentElement.outerHTML"));
        let index = 0;
        for (const session of allSessions()) {
            if (session.closed || !session.target.url.startsWith("vscode-webview://")) continue;
            const webview = new Webview(session);
            write(`webview${index}.html`, await webview.html());
            write(`webview${index}.errors.txt`, webview.errors.join("\n"));
            index++;
        }
    } catch (error) {
        write("dump-failed.txt", String(error));
    }
}

// Chrome DevTools Protocol client for the test window.
//
// The VS Code API gives an extension no way to look at what the user sees: the content of a
// webview, the status bar, the Object Explorer tree, a notification. scripts/test-vscode.mjs
// starts VS Code with --remote-debugging-port; through it the tests read the DOM of the workbench
// and of the webviews, and collect what their consoles report (script errors, Content Security
// Policy violations, files that failed to load).

import * as http from "node:http";
import { env } from "./env";

export interface Target {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

/** Pages and frames the browser process of the test window can debug. */
export function listTargets(): Promise<Target[]> {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: env.debugPort, path: "/json/list" }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        }).on("error", reject);
    });
}

interface RemoteObject {
    type: string;
    value?: unknown;
    description?: string;
}

function describeRemoteObject(object: RemoteObject): string {
    if (object.value !== undefined) {
        return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
    }
    return object.description ?? object.type;
}

/** A debugging session with one page or frame. */
export class Session {
    private _nextId = 1;
    private readonly _pending = new Map<
        number,
        { resolve: (value: any) => void; reject: (error: Error) => void }
    >();

    /**
     * What went wrong in the page so far, including before the session was attached: uncaught
     * exceptions, console.error calls, and errors logged by the browser itself (a resource that
     * failed to load, something the Content Security Policy blocked).
     */
    public readonly errors: string[] = [];

    private constructor(
        public readonly target: Target,
        private readonly _socket: WebSocket,
    ) {
        _socket.addEventListener("message", (event) =>
            this.onMessage(JSON.parse(String(event.data))),
        );
        _socket.addEventListener("close", () => {
            for (const { reject } of this._pending.values()) {
                reject(new Error(`The debugging session with ${target.url} closed`));
            }
            this._pending.clear();
        });
    }

    public static async attach(target: Target): Promise<Session> {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
                "error",
                () => reject(new Error(`Cannot debug ${target.url}`)),
                { once: true },
            );
        });
        const session = new Session(target, socket);
        // Both replay what was collected before the session was attached.
        await session.send("Runtime.enable");
        await session.send("Log.enable");
        return session;
    }

    public get closed(): boolean {
        return this._socket.readyState !== WebSocket.OPEN;
    }

    public send<T = any>(method: string, params: object = {}): Promise<T> {
        const id = this._nextId++;
        return new Promise<T>((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._socket.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Evaluates a JavaScript expression in the page and returns its JSON-serializable value. */
    public async evaluate<T>(expression: string): Promise<T> {
        const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (exceptionDetails) {
            throw new Error(
                `Evaluation failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}\n${expression}`,
            );
        }
        return result.value as T;
    }

    /** A click of the left mouse button at this point of the page. */
    public async clickAt(x: number, y: number): Promise<void> {
        const common = { x, y, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
    }

    public close(): void {
        this._socket.close();
    }

    private onMessage(message: any): void {
        if (message.id !== undefined) {
            const pending = this._pending.get(message.id);
            this._pending.delete(message.id);
            if (message.error) {
                pending?.reject(
                    new Error(
                        `${message.error.message} (${JSON.stringify(message.error.data ?? "")})`,
                    ),
                );
            } else {
                pending?.resolve(message.result);
            }
            return;
        }
        switch (message.method) {
            case "Runtime.exceptionThrown": {
                const details = message.params.exceptionDetails;
                this.errors.push(`Uncaught: ${details.exception?.description ?? details.text}`);
                break;
            }
            case "Runtime.consoleAPICalled":
                if (message.params.type === "error" || message.params.type === "assert") {
                    this.errors.push(
                        `console.error: ${message.params.args.map(describeRemoteObject).join(" ")}`,
                    );
                }
                break;
            case "Log.entryAdded": {
                const entry = message.params.entry;
                if (entry.level === "error") {
                    this.errors.push(
                        `${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`,
                    );
                }
                break;
            }
        }
    }
}

const sessions = new Map<string, Session>();

async function sessionOf(target: Target): Promise<Session> {
    let session = sessions.get(target.id);
    if (!session || session.closed) {
        session = await Session.attach(target);
        sessions.set(target.id, session);
    }
    return session;
}

/** Every session opened so far, including those of webviews that are closed by now. */
export function allSessions(): Session[] {
    return [...sessions.values()];
}

export function closeAllSessions(): void {
    for (const session of sessions.values()) {
        session.close();
    }
}

/** The window of VS Code itself. */
export async function workbench(): Promise<Session> {
    const target = (await listTargets()).find(
        (t) => t.type === "page" && t.url.includes("workbench"),
    );
    if (!target) {
        throw new Error("The workbench window is not among the debugging targets");
    }
    return sessionOf(target);
}

/**
 * A webview of the extension. VS Code hosts a webview in an <iframe> of its own (the debugging
 * target), which holds the extension's HTML in a nested, same-origin <iframe id="active-frame">.
 */
export class Webview {
    constructor(public readonly session: Session) {}

    /**
     * Evaluates an expression inside the extension's HTML: `document` and `window` are those of
     * the page the extension wrote. Yields null while that page is not loaded.
     */
    public evaluate<T>(expression: string): Promise<T | null> {
        return this.session.evaluate<T | null>(`(() => {
            const frame = document.querySelector("iframe#active-frame");
            if (!frame || !frame.contentDocument) return null;
            return ((document, window) => (${expression}))(frame.contentDocument, frame.contentWindow);
        })()`);
    }

    /** Text the page shows, as the user reads it. */
    public async text(): Promise<string> {
        return (await this.evaluate<string>("document.body ? document.body.innerText : ''")) ?? "";
    }

    public async html(): Promise<string> {
        return (await this.evaluate<string>("document.documentElement.outerHTML")) ?? "";
    }

    public get errors(): string[] {
        return this.session.errors;
    }
}

/**
 * The open webviews of the extension whose page is the given bundle of dist/views
 * ("connectionDialog", "connectionGroup" or "queryResult").
 */
export async function findWebviews(bundle: string): Promise<Webview[]> {
    const found: Webview[] = [];
    for (const target of await listTargets()) {
        if (
            !target.url.startsWith("vscode-webview://") ||
            !target.url.toLowerCase().includes(`extensionid=${env.extensionId}`)
        ) {
            continue;
        }
        try {
            const webview = new Webview(await sessionOf(target));
            if (
                await webview.evaluate<boolean>(
                    `!!document.querySelector('script[src="${bundle}.js"]')`,
                )
            ) {
                found.push(webview);
            }
        } catch {
            // The webview closed meanwhile.
        }
    }
    return found;
}

// Plumbing shared by the scripts that run the PACKAGED extension in a real, blank VS Code:
// packaging, installing the .vsix into an empty profile, bundling the code that runs inside the
// window, finding a free port. Used by scripts/screenshots.mjs.
//
// scripts/test-vscode.mjs predates this file and still holds its own copy of these helpers;
// it can switch to this module whenever it is next touched.

import { spawnSync } from "node:child_process";
import { readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { resolveCliPathFromVSCodeExecutablePath } from "@vscode/test-electron";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Where VS Code downloads and profiles live; ignored by git. */
export const cacheDir = path.join(rootDir, ".vscode-test");

/** A logger that prefixes its steps with the time elapsed since it was created. */
export function stepLogger(label) {
    const startedAt = Date.now();
    return (message) =>
        console.log(`\n[${label} +${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${message}`);
}

export function run(command, args, what) {
    const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error(`${what} failed (exit code ${result.status ?? result.signal})`);
    }
}

/** Packages the working tree with vsce (production build) into `vsix`. */
export function packageExtension(vsix) {
    const vsce = path.join(rootDir, "node_modules", "@vscode", "vsce", "vsce");
    run(process.execPath, [vsce, "package", "--no-dependencies", "--out", vsix], "vsce package");
}

/** Installs the .vsix like a user would, and returns the folder VS Code unpacked it into. */
export async function installVsix({
    vscodeExecutablePath,
    vsix,
    extensionsDir,
    userDataDir,
    extensionId,
}) {
    const codeCli = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
    run(
        codeCli,
        [
            `--extensions-dir=${extensionsDir}`,
            `--user-data-dir=${userDataDir}`,
            "--install-extension",
            vsix,
        ],
        "Installing the .vsix",
    );
    const installed = (await readdir(extensionsDir)).filter((name) =>
        name.toLowerCase().startsWith(extensionId),
    );
    if (installed.length !== 1) {
        throw new Error(
            `Expected one ${extensionId} folder in ${extensionsDir}, found: ${installed.join(", ") || "none"}`,
        );
    }
    return path.join(extensionsDir, installed[0]);
}

/**
 * Bundles `entry` (TypeScript that runs in the extension host of the window and exports `run()`)
 * into `outDir/index.js`, next to the manifest that makes the folder the "extension under
 * development" VS Code requires to run code in a test window. `vscode` is provided by VS Code.
 */
export async function bundleWindowCode(entry, outDir) {
    await rm(outDir, { recursive: true, force: true });
    await esbuild.build({
        entryPoints: [entry],
        outfile: path.join(outDir, "index.js"),
        bundle: true,
        external: ["vscode"],
        format: "cjs",
        platform: "node",
        target: "es2022",
        sourcemap: "inline",
    });
    await writeFile(
        path.join(outDir, "package.json"),
        JSON.stringify({
            name: "yast-window-code",
            publisher: "yast-tests",
            version: "0.0.0",
            engines: { vscode: "*" },
        }),
    );
}

/** True when nothing listens on this port of the loopback interface. */
export function isPortFree(port) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}

/** A port nobody listens on. */
export function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** Ends the window started with this profile folder; runTests() gives no handle on its process. */
export function killWindow(userDataDir) {
    if (process.platform === "win32") {
        process.exit(1);
    }
    // Only a process started with the profile folder of this run can match.
    spawnSync("pkill", ["-f", "--", `--user-data-dir=${userDataDir}`]);
}

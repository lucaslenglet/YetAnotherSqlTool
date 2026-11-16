// npm run test:vscode [-- --vsix <file>] [--version <stable|minimum|insiders|x.y.z>]
//                     [--executable <path>]
//
// End-to-end test of the extension AS PACKAGED, in a real VS Code:
//   1. packages the extension (vsce, production build), unless --vsix gives a package to test;
//   2. installs that .vsix with VS Code's own CLI into an empty extensions folder, next to an
//      empty user profile: no node_modules, no other extension, nothing of the developer's VS Code;
//   3. starts SQL Server and PostgreSQL (Testcontainers, as the integration tests do) and writes
//      a connection profile for each into the settings of that profile;
//   4. runs the mocha suites of test/vscode/ inside that VS Code, then removes the containers;
//   5. fails when the extension host log holds an error that comes from the extension.
//
// --version picks the VS Code to run in: "stable" (default), "minimum" for the oldest version
// the manifest accepts (engines.vscode), or an exact version. $VSCODE_VERSION does the same.
// --executable runs an editor already on disk instead, e.g. an unpacked VSCodium
// (`--executable <dir>/codium`): VS Code builds without Microsoft's services, that install from
// Open VSX.
//
// Everything is created under .vscode-test/ (ignored by git); the developer's own VS Code profile
// and extensions are never read or written. Needs Docker, and on Linux a display:
// `xvfb-run -a npm run test:vscode` on a machine without one.

import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
    downloadAndUnzipVSCode,
    resolveCliPathFromVSCodeExecutablePath,
    runTests,
} from "@vscode/test-electron";
import { startDatabases } from "../test/support/containers.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(rootDir, ".vscode-test");
// Everything one run creates; emptied at the start of each run, kept afterwards for inspection.
const runDir = path.join(cacheDir, "run");
const userDataDir = path.join(runDir, "user-data");
const extensionsDir = path.join(runDir, "extensions");
const workspaceDir = path.join(runDir, "workspace");
const artifactsDir = path.join(runDir, "artifacts");
// Compiled test suites, and the manifest that makes this folder the "extension under development"
// VS Code requires to run tests. The extension under test is the installed one.
const testsOutDir = path.join(rootDir, "out", "test-vscode");

const { values: cli } = parseArgs({
    options: {
        vsix: { type: "string" },
        version: { type: "string", default: process.env.VSCODE_VERSION || "stable" },
        executable: { type: "string" },
    },
});

/** The command-line launcher next to an editor executable (VSCodium's is bin/codium). */
function cliPath(executablePath) {
    if (path.basename(executablePath) === "codium")
        return path.join(path.dirname(executablePath), "bin", "codium");
    return resolveCliPathFromVSCodeExecutablePath(executablePath);
}

const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
// Lowercase, as VS Code names the install folder and as the comparisons below expect: the
// publisher ID ("YetAnotherSqlTool") has capitals.
const extensionId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
// "^1.101.0" -> "1.101.0"
const vscodeVersion =
    cli.version === "minimum" ? manifest.engines.vscode.replace(/^[^\d]*/, "") : cli.version;

const startedAt = Date.now();
function step(message) {
    console.log(`\n[test:vscode +${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${message}`);
}

function run(command, args, what) {
    const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error(`${what} failed (exit code ${result.status ?? result.signal})`);
    }
}

/** The .vsix to test: the one given with --vsix, else a fresh package of the working tree. */
async function resolveVsix() {
    if (cli.vsix) {
        const vsix = path.resolve(cli.vsix);
        if (!existsSync(vsix)) throw new Error(`--vsix: ${vsix} does not exist`);
        return vsix;
    }
    step("Packaging the extension (vsce package: production build, notices)");
    const vsix = path.join(runDir, `${manifest.name}.vsix`);
    const vsce = path.join(rootDir, "node_modules", "@vscode", "vsce", "vsce");
    run(process.execPath, [vsce, "package", "--no-dependencies", "--out", vsix], "vsce package");
    return vsix;
}

/** Installs the .vsix like a user would, and returns the folder VS Code unpacked it into. */
async function installVsix(vscodeExecutablePath, vsix) {
    const codeCli = cliPath(vscodeExecutablePath);
    const result = spawnSync(
        codeCli,
        [
            `--extensions-dir=${extensionsDir}`,
            `--user-data-dir=${userDataDir}`,
            "--install-extension",
            vsix,
        ],
        { cwd: rootDir, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
    );
    process.stdout.write(result.stdout ?? "");
    if (result.status !== 0) {
        // The CLI of VS Code 1.101 sometimes crashes while exiting ("FATAL ERROR:
        // v8::ToLocalChecked Empty MaybeLocal", exit code 134), after the installation is done.
        // Seen on GitHub's runners. What counts is that VS Code reported the installation.
        if (!/was successfully installed/.test(result.stdout ?? "")) {
            throw new Error(
                `Installing the .vsix failed (exit code ${result.status ?? result.signal})`,
            );
        }
        console.warn(
            `VS Code's CLI exited with ${result.status ?? result.signal} after installing the extension; continuing.`,
        );
    }
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

async function compileTests() {
    await rm(testsOutDir, { recursive: true, force: true });
    const sourceDir = path.join(rootDir, "test", "vscode");
    const entryPoints = (await readdir(sourceDir))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => path.join(sourceDir, f));
    // Transpiled file by file: `vscode` is provided by VS Code, mocha comes from node_modules.
    await esbuild.build({
        entryPoints,
        outdir: testsOutDir,
        format: "cjs",
        platform: "node",
        target: "es2022",
        sourcemap: "inline",
    });
    await writeFile(
        path.join(testsOutDir, "package.json"),
        JSON.stringify({
            name: "yast-vscode-tests",
            publisher: "yast-tests",
            version: "0.0.0",
            engines: { vscode: "*" },
        }),
    );
}

/** A port nobody listens on, for the DevTools protocol the tests use to look inside the webviews. */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** The profiles the tests connect with. Ids and names are what the tests look for. */
function connectionProfiles({ mssql, pg }) {
    return [
        {
            id: "smoke-mssql",
            profileName: "Smoke SQL Server",
            provider: "mssql",
            server: `${mssql.host},${mssql.port}`,
            database: mssql.database,
            authenticationType: "SqlLogin",
            user: mssql.user,
            // In plain text, as dev-workspace/ does: only the extension can write to its SecretStorage.
            password: mssql.password,
            encrypt: "Mandatory",
            trustServerCertificate: true,
        },
        {
            id: "smoke-pg",
            profileName: "Smoke PostgreSQL",
            provider: "pg",
            server: pg.host,
            port: pg.port,
            database: pg.database,
            authenticationType: "SqlLogin",
            user: pg.user,
            password: pg.password,
        },
        // The same servers through a database filter (test/vscode/connectionFilter.e2e.ts). They
        // come after the two above, which `profile(provider)` and the connection quick pick find first.
        {
            id: "filtered-mssql",
            profileName: "Filtered SQL Server",
            provider: "mssql",
            server: `${mssql.host},${mssql.port}`,
            database: mssql.database,
            authenticationType: "SqlLogin",
            user: mssql.user,
            password: mssql.password,
            encrypt: "Mandatory",
            trustServerCertificate: true,
            databaseFilter: "ms*",
        },
        {
            id: "filtered-pg",
            profileName: "Filtered PostgreSQL",
            provider: "pg",
            server: pg.host,
            port: pg.port,
            database: pg.database,
            authenticationType: "SqlLogin",
            user: pg.user,
            password: pg.password,
            databaseFilter: "post*",
        },
    ];
}

async function writeUserSettings(profiles) {
    const settings = {
        "yast.connections": profiles,
        // The connection quick pick then lists the saved profiles only, in the order above.
        "yast.maxRecentConnections": 0,
        // Quick picks must stay open when the test window is not the focused one.
        "workbench.quickOpen.closeOnFocusLost": false,
        "workbench.startupEditor": "none",
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "extensions.ignoreRecommendations": true,
        "chat.disableAIFeatures": true,
        "window.restoreWindows": "none",
        // The test workspace lies inside this repository: git must not offer to open it.
        "git.enabled": false,
        // Save dialogs as quick inputs, which the tests can fill (the native ones are out of reach).
        "files.simpleDialog.enable": true,
    };
    await mkdir(path.join(userDataDir, "User"), { recursive: true });
    await writeFile(
        path.join(userDataDir, "User", "settings.json"),
        JSON.stringify(settings, null, 4),
    );
    // A window that runs tests is a development window, where Ctrl+R reloads the window: give
    // Ctrl+R back its everyday meaning (Open Recent), which the shortcut tests rely on.
    await writeFile(
        path.join(userDataDir, "User", "keybindings.json"),
        JSON.stringify([{ key: "ctrl+r", command: "-workbench.action.reloadWindow" }], null, 4),
    );
}

async function findFiles(dir, predicate) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(
        () => [],
    )) {
        const file = path.join(entry.parentPath, entry.name);
        if (entry.isFile() && predicate(file)) found.push(file);
    }
    return found;
}

/**
 * Error-level entries of the extension host logs that come from the extension: anything in its
 * own output channels, and entries of the host's log that name it or its install folder.
 */
async function extensionLogErrors(installDir) {
    const logs = await findFiles(
        path.join(userDataDir, "logs"),
        (file) => file.endsWith(".log") && file.includes("exthost"),
    );
    const errors = [];
    for (const file of logs) {
        const own =
            file.toLowerCase().includes(extensionId) ||
            /output_logging_[^/\\]*[/\\][^/\\]*yast/i.test(file);
        // An entry is a "<date> [level] ..." line plus the lines that follow it (stack traces).
        const entries = (await readFile(file, "utf8")).split(/\r?\n(?=\d{4}-\d{2}-\d{2} )/);
        for (const entry of entries) {
            if (!/^\S+ \S+ \[error\]/.test(entry)) continue;
            if (own || entry.toLowerCase().includes(extensionId) || entry.includes(installDir)) {
                errors.push(`${path.relative(userDataDir, file)}: ${entry.trim()}`);
            }
        }
    }
    return errors;
}

/** The whole test takes well under a minute; a window still there after this long is stuck. */
const WINDOW_TIMEOUT_MS = 10 * 60 * 1000;

/** Ends the test window, which makes runTests() fail: it gives no handle on the process it starts. */
function killTestWindow() {
    console.error(
        `\nThe test window is still open after ${WINDOW_TIMEOUT_MS / 60000} minutes: closing it.`,
    );
    if (process.platform === "win32") {
        // No pkill there: give up. The exit handler of containers.mjs still removes the containers.
        process.exit(1);
    }
    // Only a process started with the profile folder of this run can match.
    spawnSync("pkill", ["-f", "--", `--user-data-dir=${userDataDir}`]);
}

let databases;
let exitCode = 0;
try {
    await rm(runDir, { recursive: true, force: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    step("Starting SQL Server and PostgreSQL in Docker (the first run downloads the images)");
    const databasesStarting = startDatabases();
    // Must not become an unhandled rejection when an earlier step fails first.
    databasesStarting.catch(() => {});

    const vsix = await resolveVsix();

    let vscodeExecutablePath;
    if (cli.executable) {
        vscodeExecutablePath = path.resolve(cli.executable);
        if (!existsSync(vscodeExecutablePath))
            throw new Error(`--executable: ${vscodeExecutablePath} does not exist`);
        step(`Using ${vscodeExecutablePath}`);
    } else {
        step(`Getting VS Code ${vscodeVersion}`);
        vscodeExecutablePath = await downloadAndUnzipVSCode({
            version: vscodeVersion,
            cachePath: cacheDir,
        });
    }

    step(`Installing ${path.relative(rootDir, vsix)} into an empty profile`);
    const installDir = await installVsix(vscodeExecutablePath, vsix);

    await compileTests();
    databases = await databasesStarting;
    const profiles = connectionProfiles(databases);
    await writeUserSettings(profiles);
    // A real file for each engine: the results are titled after it.
    await cp(path.join(rootDir, "test", "vscode", "workspace"), workspaceDir, { recursive: true });
    const debugPort = await freePort();

    step("Running the tests in VS Code");
    const watchdog = setTimeout(killTestWindow, WINDOW_TIMEOUT_MS);
    try {
        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath: testsOutDir,
            extensionTestsPath: path.join(testsOutDir, "index.js"),
            launchArgs: [
                workspaceDir,
                `--extensions-dir=${extensionsDir}`,
                `--user-data-dir=${userDataDir}`,
                // Lets the tests read the DOM and the console of the workbench and of the webviews.
                `--remote-debugging-port=${debugPort}`,
                // SecretStorage without the keyring of the desktop session: CI has none, and the
                // developer's is not ours to write to.
                "--password-store=basic",
                // On a Wayland desktop, a window that is not the focused one can neither write nor read
                // the clipboard, which the copy test does. X11 (XWayland, or Xvfb on CI) lets it.
                ...(process.platform === "linux" && process.env.DISPLAY
                    ? ["--ozone-platform=x11"]
                    : []),
            ],
            extensionTestsEnv: {
                YAST_TEST_EXTENSION_ID: extensionId,
                YAST_TEST_INSTALL_DIR: installDir,
                YAST_TEST_PROFILES: JSON.stringify(profiles),
                YAST_TEST_DEBUG_PORT: String(debugPort),
                YAST_TEST_ARTIFACTS: artifactsDir,
                YAST_TEST_USER_SETTINGS: path.join(userDataDir, "User", "settings.json"),
            },
        });
    } catch (error) {
        exitCode = 1;
        console.error(
            `\nThe tests failed: ${error.message}. DOM dumps, if any: ${path.relative(rootDir, artifactsDir)}`,
        );
    } finally {
        clearTimeout(watchdog);
    }

    step("Checking the extension host log");
    const errors = await extensionLogErrors(installDir);
    if (errors.length > 0) {
        exitCode = 1;
        console.error(`The extension logged ${errors.length} error(s):\n${errors.join("\n")}`);
    } else {
        console.log("No error from the extension.");
    }
} catch (error) {
    exitCode = 1;
    console.error(`\n${error.stack ?? error}`);
} finally {
    await databases
        ?.stop()
        .catch((error) => console.error(`Could not remove the containers: ${error.message}`));
}
step(exitCode === 0 ? "Passed" : "FAILED");
// Also removes the containers of databases that were still starting when an earlier step failed.
process.exit(exitCode);

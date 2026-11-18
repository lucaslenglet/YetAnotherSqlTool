// npm run screenshots [-- --vsix <file>] [--version <stable|minimum|insiders|x.y.z>]
//
// Regenerates the PNG files of media/screenshots/ (the images of README.md) from the extension AS
// PACKAGED, in a real but blank VS Code, as scripts/test-vscode.mjs does:
//   1. packages the extension, installs the .vsix into an empty profile under .vscode-test/;
//   2. starts SQL Server and PostgreSQL (Testcontainers) and fills them with demo data
//      (test/screenshots/seed.mjs on top of test/fixtures);
//   3. opens VS Code on a workspace named "demo", with settings that hide everything that would
//      distract (no minimap, no notifications...), and runs test/screenshots/scenario.ts in it:
//      it drives the UI the way a user would and captures the window with the DevTools protocol;
//   4. removes the containers.
//
// A VS Code window opens on your desktop for about a minute: do not touch it meanwhile. The
// developer's own VS Code profile and extensions are never read or written.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { startDatabases } from "../test/support/containers.mjs";
import { seedMssql, seedPostgres } from "../test/screenshots/seed.mjs";
import {
    bundleWindowCode,
    cacheDir,
    freePort,
    installVsix,
    isPortFree,
    killWindow,
    packageExtension,
    rootDir,
    stepLogger,
} from "./lib/vscode-e2e.mjs";

const runDir = path.join(cacheDir, "screenshots");
const userDataDir = path.join(runDir, "user-data");
const extensionsDir = path.join(runDir, "extensions");
// The folder name is what the window title shows: keep it neutral.
const workspaceDir = path.join(runDir, "demo");
const artifactsDir = path.join(runDir, "artifacts");
const windowCodeDir = path.join(rootDir, "out", "screenshots");
const outputDir = path.join(rootDir, "media", "screenshots");

const { values: cli } = parseArgs({
    options: {
        vsix: { type: "string" },
        version: { type: "string", default: process.env.VSCODE_VERSION || "stable" },
    },
});

const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
// Lowercase, as VS Code names the install folder (the publisher ID has capitals).
const extensionId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const vscodeVersion =
    cli.version === "minimum" ? manifest.engines.vscode.replace(/^[^\d]*/, "") : cli.version;
const step = stepLogger("screenshots");

/** The usual ports of the engines when they are free (the port shows in the editor's connection), else random ones. */
async function preferredPorts() {
    const [mssqlPort, pgPort] = await Promise.all([isPortFree(1433), isPortFree(5432)]);
    return { mssqlPort: mssqlPort ? 1433 : undefined, pgPort: pgPort ? 5432 : undefined };
}

function connectionProfiles({ mssql, pg }) {
    return [
        {
            id: "demo-mssql",
            profileName: "Sales (SQL Server)",
            provider: "mssql",
            server: mssql.port === 1433 ? mssql.host : `${mssql.host},${mssql.port}`,
            database: mssql.database,
            authenticationType: "SqlLogin",
            user: mssql.user,
            // In plain text, as dev-workspace/ does: only the extension can write to its SecretStorage.
            password: mssql.password,
            encrypt: "Mandatory",
            trustServerCertificate: true,
        },
        {
            id: "demo-pg",
            profileName: "Sales (PostgreSQL)",
            provider: "pg",
            server: pg.host,
            ...(pg.port === 5432 ? {} : { port: pg.port }),
            database: pg.database,
            authenticationType: "SqlLogin",
            user: pg.user,
            password: pg.password,
        },
    ];
}

async function writeUserSettings(profiles) {
    const settings = {
        "yast.connections": profiles,
        "yast.maxRecentConnections": 0,
        // Same look on every machine: the default dark theme, nothing that distracts.
        "workbench.colorTheme": "Default Dark Modern",
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "workbench.enableExperiments": false,
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        "workbench.layoutControl.enabled": false,
        "workbench.editor.enablePreview": false,
        "window.commandCenter": false,
        "window.titleBarStyle": "native",
        "window.restoreWindows": "none",
        "editor.minimap.enabled": false,
        "editor.fontSize": 14,
        "editor.renderLineHighlight": "none",
        "editor.occurrencesHighlight": "off",
        "editor.codeLens": true,
        "editor.suggest.showWords": false,
        "breadcrumbs.enabled": false,
        "security.workspace.trust.enabled": false,
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "update.showReleaseNotes": false,
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "extensions.ignoreRecommendations": true,
        "chat.disableAIFeatures": true,
        "git.enabled": false,
        // Quick picks must stay open when the window is not the focused one.
        "workbench.quickOpen.closeOnFocusLost": false,
    };
    await mkdir(path.join(userDataDir, "User"), { recursive: true });
    await writeFile(
        path.join(userDataDir, "User", "settings.json"),
        JSON.stringify(settings, null, 4),
    );
}

/** The whole run takes a couple of minutes; a window still there after this long is stuck. */
const WINDOW_TIMEOUT_MS = 10 * 60 * 1000;

let databases;
let exitCode = 0;
try {
    await rm(runDir, { recursive: true, force: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    step("Starting SQL Server and PostgreSQL in Docker (the first run downloads the images)");
    const databasesStarting = startDatabases(await preferredPorts());
    // Must not become an unhandled rejection when an earlier step fails first.
    databasesStarting.catch(() => {});

    let vsix;
    if (cli.vsix) {
        vsix = path.resolve(cli.vsix);
        if (!existsSync(vsix)) throw new Error(`--vsix: ${vsix} does not exist`);
    } else {
        step("Packaging the extension (vsce package: production build, notices)");
        vsix = path.join(runDir, `${manifest.name}.vsix`);
        packageExtension(vsix);
    }

    step(`Getting VS Code ${vscodeVersion}`);
    const vscodeExecutablePath = await downloadAndUnzipVSCode({
        version: vscodeVersion,
        cachePath: cacheDir,
    });

    step(`Installing ${path.relative(rootDir, vsix)} into an empty profile`);
    const installDir = await installVsix({
        vscodeExecutablePath,
        vsix,
        extensionsDir,
        userDataDir,
        extensionId,
    });

    await bundleWindowCode(path.join(rootDir, "test", "screenshots", "scenario.ts"), windowCodeDir);
    databases = await databasesStarting;

    step("Filling the databases with demo data");
    await seedMssql(databases.mssql);
    await seedPostgres(databases.pg);

    const profiles = connectionProfiles(databases);
    await writeUserSettings(profiles);
    await cp(path.join(rootDir, "test", "screenshots", "workspace"), workspaceDir, {
        recursive: true,
    });
    const debugPort = await freePort();

    step("Taking the screenshots in VS Code");
    const watchdog = setTimeout(() => killWindow(userDataDir), WINDOW_TIMEOUT_MS);
    try {
        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath: windowCodeDir,
            extensionTestsPath: path.join(windowCodeDir, "index.js"),
            launchArgs: [
                workspaceDir,
                `--extensions-dir=${extensionsDir}`,
                `--user-data-dir=${userDataDir}`,
                // Lets the scenario capture the window and read the DOM of the webviews.
                `--remote-debugging-port=${debugPort}`,
                "--password-store=basic",
                ...(process.platform === "linux" && process.env.DISPLAY
                    ? ["--ozone-platform=x11"]
                    : []),
            ],
            extensionTestsEnv: {
                // What test/vscode/env.ts, used by the helpers of the scenario, reads.
                YAST_TEST_EXTENSION_ID: extensionId,
                YAST_TEST_INSTALL_DIR: installDir,
                YAST_TEST_PROFILES: JSON.stringify(profiles),
                YAST_TEST_DEBUG_PORT: String(debugPort),
                YAST_TEST_ARTIFACTS: artifactsDir,
                YAST_TEST_USER_SETTINGS: path.join(userDataDir, "User", "settings.json"),
                YAST_SCREENSHOTS_DIR: outputDir,
            },
        });
    } catch (error) {
        exitCode = 1;
        console.error(
            `\nThe scenario failed: ${error.message}. DOM dumps, if any: ${path.relative(rootDir, artifactsDir)}`,
        );
    } finally {
        clearTimeout(watchdog);
    }
} catch (error) {
    exitCode = 1;
    console.error(`\n${error.stack ?? error}`);
} finally {
    await databases
        ?.stop()
        .catch((error) => console.error(`Could not remove the containers: ${error.message}`));
}
step(exitCode === 0 ? `Done: ${path.relative(rootDir, outputDir)}` : "FAILED");
// Also removes the containers of databases that were still starting when an earlier step failed.
process.exit(exitCode);

// Builds the extension (Node, CommonJS) and the webviews (browser, ESM) with esbuild.
// Usage: node scripts/build.mjs [--watch] [--prod]
//
// --prod is what gets packaged (npm run build:prod): minified, without source maps.
// scripts/notices.mjs imports createConfigs() to list the packages bundled by that build.
import * as esbuild from "esbuild";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Code copied from vscode-mssql imports its internal toolkit package by name;
// we vendor it under src/vendor instead.
const alias = {
    "extension-toolkit/base": "./src/vendor/extension-toolkit/base/index.ts",
    "extension-toolkit/vscode": "./src/vendor/extension-toolkit/vscode/index.ts",
};

// "vscode-mssql" only provides types. If it ends up required at runtime, the
// extension would crash on activation, so fail the build instead.
const typesOnlyModules = ["vscode-mssql"];
const typesOnlyGuard = {
    name: "types-only-guard",
    setup(build) {
        build.onEnd(async (result) => {
            if (result.errors.length > 0) return;
            const out = await readFile(path.join(rootDir, "dist/extension.js"), "utf8");
            for (const m of typesOnlyModules) {
                if (new RegExp(`require\\(["']${m}["']\\)`).test(out)) {
                    result.errors.push({
                        text: `dist/extension.js requires types-only module '${m}' at runtime`,
                    });
                }
            }
        });
    },
};

// Packages a dependency requires inside a try/catch and works without (`debug` only uses
// "supports-color" to pick more colors). The package has no node_modules, so the require would
// always throw: bundle an empty module instead of leaving a require of something not shipped.
const optionalModules = ["supports-color"];
const optionalModulesPlugin = {
    name: "optional-modules",
    setup(build) {
        const filter = new RegExp(`^(${optionalModules.join("|")})$`);
        build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "optional-module" }));
        build.onLoad({ filter: /.*/, namespace: "optional-module" }, () => ({
            contents: "module.exports = undefined;",
            loader: "js",
        }));
    },
};

/**
 * esbuild options of the two bundles: the extension and the webviews.
 * @param {{ prod?: boolean }} [options]
 * @returns {import("esbuild").BuildOptions[]}
 */
export function createConfigs({ prod = false } = {}) {
    const extensionConfig = {
        absWorkingDir: rootDir,
        entryPoints: { extension: "src/extension.ts" },
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "es2024",
        external: ["vscode", ...typesOnlyModules],
        mainFields: ["module", "main"],
        outdir: "dist",
        sourcemap: !prod,
        minify: prod,
        alias,
        tsconfig: "tsconfig.extension.json",
        logOverride: { "import-is-undefined": "error" },
        plugins: [optionalModulesPlugin, typesOnlyGuard],
    };

    const webviewsConfig = {
        absWorkingDir: rootDir,
        // One entry per webview page.
        entryPoints: {
            connectionDialog: "src/webviews/pages/ConnectionDialog/index.tsx",
            connectionGroup: "src/webviews/pages/ConnectionGroup/index.tsx",
            queryResult: "src/webviews/pages/QueryResult/index.tsx",
        },
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2024",
        splitting: true,
        outdir: "dist/views",
        sourcemap: prod ? false : "inline",
        minify: prod,
        alias,
        tsconfig: "tsconfig.webviews.json",
        loader: {
            ".svg": "file",
            ".png": "file",
            ".gif": "file",
            ".webp": "file",
            ".ttf": "file",
            ".woff": "file",
            ".woff2": "file",
        },
    };

    return [extensionConfig, webviewsConfig];
}

async function main() {
    const watch = process.argv.includes("--watch");
    const prod = process.argv.includes("--prod");
    const configs = createConfigs({ prod });

    // Chunk and asset names contain a content hash, so files of previous builds
    // (and source maps of a development build) would otherwise pile up and get packaged.
    await rm(path.join(rootDir, "dist"), { recursive: true, force: true });

    if (watch) {
        const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
        await Promise.all(contexts.map((c) => c.watch()));
        console.log("[watch] build started");
    } else {
        await Promise.all(configs.map((c) => esbuild.build(c)));
        console.log(prod ? "production build done" : "build done");
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}

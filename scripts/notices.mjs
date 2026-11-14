// Generates ThirdPartyNotices.txt: name, version, license and license text of every npm
// package that esbuild really bundles into dist/ (taken from esbuild's metafile of the
// production build, so tree-shaken and dev-only packages are left out).
//
// Usage: node scripts/notices.mjs [--check]
//   --check  do not write; fail if ThirdPartyNotices.txt is out of date.
//
// The script fails when a bundled package has a license that is not in `permissiveLicenses`
// or has no license text: review the package, then extend the tables below.
import * as esbuild from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createConfigs, rootDir } from "./build.mjs";

const outputFile = path.join(rootDir, "ThirdPartyNotices.txt");
const check = process.argv.includes("--check");

// Licenses that allow redistribution in a bundled, minified extension with no other
// obligation than reproducing the license text (which this file does).
const permissiveLicenses = new Set([
    "0BSD",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "ISC",
    "MIT",
    "Unlicense",
]);

// Copyright holder of MIT packages that ship neither a license file nor a license section
// in their README and have no `author` in package.json (taken from their repository).
const copyrightHolders = {
    "@fluentui-contrib/react-data-grid-react-window": "Microsoft Corporation",
    "@fluentui/react-icons": "Microsoft Corporation",
};

// Bundled assets whose license differs from the license of the package that ships them.
const assetNotices = [
    {
        pattern: /(^|\/)codicon\.ttf$/,
        id: "vscode-codicons (codicon.ttf icon font, shipped inside monaco-editor)",
        license: "CC-BY-4.0",
        url: "https://github.com/microsoft/vscode-codicons",
        text: [
            "Copyright (c) Microsoft Corporation.",
            "",
            "The icons of vscode-codicons, distributed here unmodified as the codicon.ttf font,",
            "are licensed under the Creative Commons Attribution 4.0 International Public License:",
            "https://creativecommons.org/licenses/by/4.0/legalcode",
        ].join("\n"),
    },
];

const licenseFilePattern = /^(licen[sc]e|copying|unlicense|notice|third-?party-?notices?)/i;

const mitText = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Files that end up in the bundles and the directories of the packages they belong to (relative to the repo root). */
async function bundledInputs() {
    const dirs = new Set();
    const files = new Set();
    for (const config of createConfigs({ prod: true })) {
        const result = await esbuild.build({
            ...config,
            plugins: [],
            write: false,
            metafile: true,
            logLevel: "error",
        });
        for (const output of Object.values(result.metafile.outputs)) {
            for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
                // Inputs can carry a namespace or a suffix ("ns:path", "path?query").
                const file = input.replace(/^[a-z-]+:(?!\/\/)/, "").replace(/[?#].*$/, "");
                const marker = file.lastIndexOf("node_modules/");
                if (bytesInOutput === 0) continue;
                files.add(file);
                if (marker < 0) continue;
                const [scope, name] = file.slice(marker + "node_modules/".length).split("/");
                const packageName = scope.startsWith("@") ? `${scope}/${name}` : scope;
                dirs.add(file.slice(0, marker + "node_modules/".length) + packageName);
            }
        }
    }
    return { dirs: [...dirs], files: [...files] };
}

function licenseId(pkg) {
    const license = pkg.license ?? pkg.licenses;
    if (typeof license === "string") return license;
    if (Array.isArray(license)) return license.map((l) => l.type ?? l).join(" OR ");
    return license?.type ?? "UNKNOWN";
}

/** Evaluates simple SPDX expressions such as "MIT", "(MIT OR GPL-3.0)" or "MIT AND ISC". */
function isPermissive(license) {
    const expression = license.replace(/[()]/g, "").trim();
    const isAllowed = (id) => permissiveLicenses.has(id.trim());
    if (/\sOR\s/.test(expression)) return expression.split(/\sOR\s/).some(isAllowed);
    return expression.split(/\sAND\s/).every(isAllowed);
}

function packageUrl(pkg) {
    if (typeof pkg.homepage === "string" && pkg.homepage) return pkg.homepage;
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (!repository) return `https://www.npmjs.com/package/${pkg.name}`;
    return repository
        .replace(/^git\+/, "")
        .replace(/^git:\/\//, "https://")
        .replace(/^github:/, "https://github.com/")
        .replace(/\.git$/, "");
}

const normalize = (text) =>
    text
        .replace(/^﻿/, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim();

/** License section of a README, when it holds the full text and not just the license name. */
function licenseFromReadme(readme) {
    const lines = normalize(readme).split("\n");
    const start = lines.findIndex((line) => /^#+\s*licen[sc]e\s*$/i.test(line));
    if (start < 0) return undefined;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#+\s/.test(line));
    const section = normalize((end < 0 ? rest : rest.slice(0, end)).join("\n"));
    return /permission is hereby granted/i.test(section) ? section : undefined;
}

/** License text(s) of a package: its license and notice files, or a documented fallback. */
async function licenseTexts(dir, pkg, license) {
    const absDir = path.join(rootDir, dir);
    const entries = await readdir(absDir, { withFileTypes: true });
    const files = entries
        .filter((e) => e.isFile() && licenseFilePattern.test(e.name))
        .map((e) => e.name)
        .sort();
    if (files.length > 0) {
        return Promise.all(
            files.map(async (name) => ({
                source: name,
                text: normalize(await readFile(path.join(absDir, name), "utf8")),
            })),
        );
    }

    const readme = entries.find(
        (e) => e.isFile() && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name),
    );
    const fromReadme =
        readme && licenseFromReadme(await readFile(path.join(absDir, readme.name), "utf8"));
    if (fromReadme) return [{ source: `${readme.name}, "License" section`, text: fromReadme }];

    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    const holder = copyrightHolders[pkg.name] ?? author?.replace(/\s*[<(].*$/, "");
    if (license === "MIT" && holder) {
        return [
            {
                source: "no license file in the package; standard MIT text, copyright holder from its metadata",
                text: mitText(holder),
            },
        ];
    }
    return [];
}

const packages = new Map();
const problems = [];
const bundled = await bundledInputs();
for (const dir of bundled.dirs) {
    const pkg = JSON.parse(await readFile(path.join(rootDir, dir, "package.json"), "utf8"));
    const id = `${pkg.name}@${pkg.version}`;
    if (packages.has(id)) continue; // same version installed at two places
    const license = licenseId(pkg);
    const texts = await licenseTexts(dir, pkg, license);
    if (!isPermissive(license))
        problems.push(`${id}: license "${license}" is not in the permissive list`);
    if (texts.length === 0) problems.push(`${id}: no license text found (${dir})`);
    packages.set(id, { id, license, url: packageUrl(pkg), texts });
}
for (const { pattern, id, license, url, text } of assetNotices) {
    if (bundled.files.some((file) => pattern.test(file))) {
        packages.set(id, { id, license, url, texts: [{ source: "attribution", text }] });
    }
}

const sorted = [...packages.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const counts = new Map();
for (const { license } of sorted) counts.set(license, (counts.get(license) ?? 0) + 1);
const summary = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

const rule = "=".repeat(80);
const thinRule = "-".repeat(80);
const lines = [
    "THIRD-PARTY SOFTWARE NOTICES AND INFORMATION",
    "",
    "YetAnotherSqlTool is distributed as bundles (dist/) that include the third-party",
    "packages listed below. Each one stays under its own license, reproduced here.",
    "",
    "The extension also contains code and icons adapted from vscode-mssql",
    "(Copyright (c) Microsoft Corporation, MIT License): see",
    "THIRD_PARTY_LICENSE_vscode-mssql.txt.",
    "",
    "This file is generated by `npm run notices` (scripts/notices.mjs) from the list of",
    "modules esbuild puts in the production build. Do not edit it by hand.",
    "",
    `${sorted.length} entries: ${summary.map(([license, count]) => `${license} (${count})`).join(", ")}`,
    "",
    ...sorted.map(({ id, license }, i) => `${String(i + 1).padStart(3)}. ${id} - ${license}`),
    "",
];
for (const { id, license, url, texts } of sorted) {
    lines.push(rule, id, `License: ${license}`, `Source: ${url}`, rule, "");
    texts.forEach(({ source, text }, i) => {
        if (i > 0) lines.push(thinRule, "");
        lines.push(`[${source}]`, "", text, "");
    });
}
const content = lines.join("\n");

if (problems.length > 0) {
    console.error(`ThirdPartyNotices: ${problems.length} package(s) need a review:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}

const relativeOutput = path.relative(rootDir, outputFile);
if (check) {
    const current = await readFile(outputFile, "utf8").catch(() => "");
    if (current !== content) {
        console.error(
            `${relativeOutput} is out of date: run \`npm run notices\` and commit the result.`,
        );
        process.exit(1);
    }
    console.log(`${relativeOutput} is up to date (${sorted.length} entries).`);
} else {
    await writeFile(outputFile, content);
    console.log(
        `${relativeOutput}: ${sorted.length} entries, ${summary.map(([l, c]) => `${l} ${c}`).join(", ")}`,
    );
}

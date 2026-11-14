// What a broken package breaks first: the extension is not found, does not activate, or lacks
// what its manifest announces.

import * as assert from "node:assert";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import * as vscode from "vscode";
import { env } from "./env";
import { extension, inWorkbench, waitFor } from "./helpers";

interface Manifest {
    main: string;
    contributes: {
        commands: { command: string }[];
        menus: Record<string, { command?: string; submenu?: string }[]>;
        keybindings: { command: string }[];
        views: Record<string, { id: string }[]>;
    };
}

describe("Packaged extension", () => {
    const manifest = () => extension().packageJSON as Manifest;

    it("is the one installed from the .vsix, without node_modules", () => {
        const installed = extension().extensionPath;
        assert.strictEqual(fs.realpathSync(installed), fs.realpathSync(env.installDir));
        assert.ok(
            fs.existsSync(path.join(installed, manifest().main)),
            "the bundle named by `main` is missing",
        );
        for (const leftOut of ["node_modules", "src", "test"]) {
            assert.ok(
                !fs.existsSync(path.join(installed, leftOut)),
                `${leftOut}/ must not be in the package`,
            );
        }
    });

    it("requires nothing at run time that is not in the package", () => {
        // The package has no node_modules: whatever the bundle still requires by name must come
        // with VS Code or Node.js, or the first code path that reaches it throws.
        const bundle = fs.readFileSync(
            path.join(extension().extensionPath, manifest().main),
            "utf8",
        );
        const required = new Set(
            [...bundle.matchAll(/\brequire\((["'`])([^"'`]+)\1\)/g)].map((match) => match[2]),
        );
        assert.ok(
            required.has("vscode"),
            "found no require() in the bundle: has its format changed?",
        );
        const provided = new Set([
            "vscode",
            ...builtinModules.flatMap((name) => [name, `node:${name}`]),
        ]);
        // pg's optional native binding: only loaded by `pg.native`, which the extension does not use.
        const optional = new Set(["pg-native"]);
        assert.deepStrictEqual(
            [...required].filter((name) => !provided.has(name) && !optional.has(name)),
            [],
            "modules required by dist/extension.js that esbuild did not bundle",
        );
    });

    it("ships every file its manifest points to", () => {
        // Icons of commands, views and view containers, the bundle, the marketplace icon.
        const paths = new Set<string>();
        const collect = (value: unknown): void => {
            if (typeof value === "string") {
                if (/^(\.\/)?(media|dist)\//.test(value)) paths.add(value);
            } else if (value && typeof value === "object") {
                Object.values(value).forEach(collect);
            }
        };
        collect(manifest());
        assert.ok(paths.size > 5, `only ${paths.size} file(s) found in the manifest`);
        const missing = [...paths].filter(
            (file) => !fs.existsSync(path.join(extension().extensionPath, file)),
        );
        assert.deepStrictEqual(
            missing,
            [],
            "files named in package.json that are not in the package",
        );
    });

    it("is alone: no Microsoft mssql extension, no other user extension", () => {
        assert.strictEqual(vscode.extensions.getExtension("ms-mssql.mssql"), undefined);
        const userExtensions = vscode.extensions.all
            .filter((e) => !e.packageJSON.isBuiltin && !e.id.startsWith("vscode."))
            .map((e) => e.id.toLowerCase())
            .sort();
        assert.deepStrictEqual(
            userExtensions,
            [env.extensionId, "yast-tests.yast-vscode-tests"].sort(),
        );
    });

    it("activates without error", async () => {
        const ext = extension();
        await ext.activate();
        assert.strictEqual(ext.isActive, true);
    });

    it("registers every command of contributes.commands", async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const declared = manifest().contributes.commands.map((c) => c.command);
        assert.ok(declared.length > 0);
        assert.deepStrictEqual(
            declared.filter((command) => !registered.has(command)),
            [],
            "commands declared in package.json that the extension does not register",
        );
    });

    it("registers every command its menus and keybindings refer to", async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const { menus, keybindings } = manifest().contributes;
        const referenced = [
            ...Object.values(menus).flatMap((items) => items.map((item) => item.command)),
            ...keybindings.map((k) => k.command),
        ].filter((command): command is string => !!command);
        assert.deepStrictEqual(
            [...new Set(referenced)].filter((command) => !registered.has(command)),
            [],
        );
    });

    it("contributes the Object Explorer view and the Query Results panel view", async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        // VS Code generates a "<view id>.focus" command for every contributed view.
        for (const viewId of ["yastObjectExplorer", "yastQueryResult"]) {
            assert.ok(registered.has(`${viewId}.focus`), `view ${viewId} is not contributed`);
        }

        await vscode.commands.executeCommand("yastQueryResult.focus");
        await waitFor("the Query Results view in the panel", () =>
            inWorkbench<boolean>(
                `!!document.querySelector('.part.panel [id="workbench.view.extension.yastQueryResult"]')`,
            ),
        );
        await vscode.commands.executeCommand("yastObjectExplorer.focus");
        await waitFor("the Object Explorer view in the side bar", () =>
            inWorkbench<boolean>(
                `!!document.querySelector('.part.sidebar [id="workbench.view.extension.yastObjectExplorerContainer"]')`,
            ),
        );
    });
});

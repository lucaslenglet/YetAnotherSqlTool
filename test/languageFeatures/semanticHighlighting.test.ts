import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { getDrivers } from "../../src/drivers";
import type { DriverId } from "../../src/drivers/types";
import {
    lineStartsOf,
    SqlSemanticTokensProvider,
    tokenModifiers,
    tokenTypes,
    type EditorProviders,
} from "../../src/languageFeatures/semanticHighlighting";
import packageJson from "../../package.json";

function fakeDocument(text: string, uri = "untitled:Untitled-1", version = 1) {
    return {
        uri: vscode.Uri.parse(uri),
        version,
        getText: () => text,
    } as unknown as vscode.TextDocument;
}

function fakeEditors(engines: Record<string, DriverId>) {
    const changed = new vscode.EventEmitter<string>();
    const editors: EditorProviders & { fire(uri: string): void } = {
        providerOf: (uri) => engines[uri],
        onDidChange: changed.event,
        fire: (uri) => changed.fire(uri),
    };
    return editors;
}

/** Decodes the relative encoding of VS Code into absolute tokens. */
function decode(tokens: vscode.SemanticTokens, text: string) {
    const lines = text.split(/\r\n|\r|\n/);
    const result: { line: number; text: string; type: string; modifiers: string[] }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
        const [deltaLine, deltaStart, length, type, modifierBits] = tokens.data.slice(i, i + 5);
        line += deltaLine;
        character = deltaLine === 0 ? character + deltaStart : deltaStart;
        result.push({
            line,
            text: lines[line].slice(character, character + length),
            type: tokenTypes[type],
            modifiers: tokenModifiers.filter((_, bit) => modifierBits & (1 << bit)),
        });
    }
    return result;
}

describe("SqlSemanticTokensProvider", () => {
    const uri = "untitled:Untitled-1";

    it("returns no tokens for an editor without a connection", () => {
        const provider = new SqlSemanticTokensProvider(fakeEditors({}), () => true);
        const tokens = provider.provideDocumentSemanticTokens(fakeDocument("SELECT 1"));
        expect(tokens.data).toHaveLength(0);
    });

    it("returns no tokens when the setting is off", () => {
        const provider = new SqlSemanticTokensProvider(fakeEditors({ [uri]: "pg" }), () => false);
        const tokens = provider.provideDocumentSemanticTokens(fakeDocument("SELECT 1"));
        expect(tokens.data).toHaveLength(0);
    });

    it("encodes the tokens of the editor's engine", () => {
        const text = "SELECT TOP 1 now() -- x";
        const pg = new SqlSemanticTokensProvider(fakeEditors({ [uri]: "pg" }), () => true);
        expect(decode(pg.provideDocumentSemanticTokens(fakeDocument(text)), text)).toEqual([
            { line: 0, text: "SELECT", type: "yastKeyword", modifiers: [] },
            { line: 0, text: "TOP", type: "yastIdentifier", modifiers: [] },
            { line: 0, text: "1", type: "number", modifiers: [] },
            { line: 0, text: "now", type: "function", modifiers: ["defaultLibrary"] },
            { line: 0, text: "-- x", type: "comment", modifiers: [] },
        ]);
        const mssql = new SqlSemanticTokensProvider(fakeEditors({ [uri]: "mssql" }), () => true);
        const types = decode(mssql.provideDocumentSemanticTokens(fakeDocument(text)), text).map(
            (token) => `${token.text} ${token.type}`,
        );
        expect(types).toContain("TOP yastKeyword");
    });

    it("cuts tokens spanning several lines at each line break, CRLF included", () => {
        const text = "SELECT /* a\r\nb */ 'x\ny',\r\n$$z$$\rFROM t";
        const provider = new SqlSemanticTokensProvider(fakeEditors({ [uri]: "pg" }), () => true);
        expect(decode(provider.provideDocumentSemanticTokens(fakeDocument(text)), text)).toEqual([
            { line: 0, text: "SELECT", type: "yastKeyword", modifiers: [] },
            { line: 0, text: "/* a", type: "comment", modifiers: [] },
            { line: 1, text: "b */", type: "comment", modifiers: [] },
            { line: 1, text: "'x", type: "string", modifiers: [] },
            { line: 2, text: "y'", type: "string", modifiers: [] },
            { line: 3, text: "$$z$$", type: "string", modifiers: [] },
            { line: 4, text: "FROM", type: "yastKeyword", modifiers: [] },
            { line: 4, text: "t", type: "yastIdentifier", modifiers: [] },
        ]);
    });

    it("returns the tokens of the lines of a range", () => {
        const text = "SELECT 1;\nSELECT 'a\nb';\nSELECT 3;";
        const provider = new SqlSemanticTokensProvider(fakeEditors({ [uri]: "pg" }), () => true);
        const tokens = provider.provideDocumentRangeSemanticTokens(
            fakeDocument(text),
            new vscode.Range(2, 0, 2, 3),
        );
        expect(decode(tokens, text)).toEqual([
            { line: 2, text: "b'", type: "string", modifiers: [] },
        ]);
    });

    it("asks for new tokens when an editor's connection changes", () => {
        const editors = fakeEditors({});
        const provider = new SqlSemanticTokensProvider(editors, () => true);
        let fired = 0;
        provider.onDidChangeSemanticTokens(() => fired++);
        provider.refresh();
        expect(fired).toBe(1);
    });

    it("classifies again when the document or its engine changes", () => {
        const engines: Record<string, DriverId> = { [uri]: "pg" };
        const provider = new SqlSemanticTokensProvider(fakeEditors(engines), () => true);
        const text = "SELECT TOP 1";
        const top = () =>
            decode(provider.provideDocumentSemanticTokens(fakeDocument(text)), text)[1].type;
        expect(top()).toBe("yastIdentifier");
        engines[uri] = "mssql";
        expect(top()).toBe("yastKeyword");
        const changed = "SELECT x";
        expect(
            decode(provider.provideDocumentSemanticTokens(fakeDocument(changed, uri, 2)), changed),
        ).toHaveLength(2);
    });

    it("splits lines like VS Code", () => {
        expect(lineStartsOf("a\r\nb\nc\rd")).toEqual([0, 3, 5, 7]);
    });

    it("declares in package.json the token types it uses", () => {
        const declared = packageJson.contributes.semanticTokenTypes.map((type) => type.id);
        const standard = ["comment", "string", "number", "operator", "function"];
        for (const type of tokenTypes) {
            expect(standard.includes(type) || declared.includes(type), type).toBe(true);
        }
        const scopes = packageJson.contributes.semanticTokenScopes[0].scopes;
        for (const type of declared) expect(scopes, type).toHaveProperty(type);
    });
});

describe("SqlLanguage of each driver", () => {
    for (const driver of getDrivers()) {
        describe(driver.displayName, () => {
            const { keywords, reservedKeywords, dataTypes, functions, constants } = driver.language;
            const all = { keywords, reservedKeywords, dataTypes, functions, constants };

            it("has non-empty, upper-case lists", () => {
                for (const [name, set] of Object.entries(all)) {
                    expect(set.size, name).toBeGreaterThan(0);
                    for (const word of set) {
                        expect(word, name).toBe(word.toUpperCase());
                        expect(word, name).toMatch(
                            /^@{0,2}[A-Z_][A-Z0-9_$#]*( [A-Z_][A-Z0-9_]*)*$/,
                        );
                    }
                }
            });

            it("has its reserved keywords and constants among its keywords", () => {
                for (const word of reservedKeywords) expect(keywords.has(word), word).toBe(true);
                for (const word of constants) expect(keywords.has(word), word).toBe(true);
            });

            it("lists functions that are not operators or internal helpers", () => {
                for (const name of functions) {
                    expect(name, name).not.toMatch(
                        /^(BINARY_UPGRADE_|PG_STAT_GET_)|_(IN|OUT|RECV|SEND)$/,
                    );
                }
            });
        });
    }
});

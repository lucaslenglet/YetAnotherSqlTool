import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
    {
        ignores: [
            "node_modules/",
            "dist/",
            "out/",
            ".vscode-test/",
            "typings/",
            "dev-workspace/",
            "**/*.generated.ts",
            "test/fixtures/",
            ".claude/",
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Directives inherited from upstream (e.g. no-restricted-syntax) refer to rules we do not use.
        linterOptions: { reportUnusedDisableDirectives: "off" },
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        rules: {
            // Upstream's lint rule, not enabled here: attaching a cause would change error objects.
            "preserve-caught-error": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
        },
    },
    {
        // Files copied from vscode-mssql and our src/ code that follows its style: these rules are
        // too noisy to fix without drifting away from upstream.
        files: ["src/**"],
        rules: {
            "prefer-const": "off",
            "no-var": "off",
            "no-case-declarations": "off",
            "no-unsafe-optional-chaining": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-namespace": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-unsafe-function-type": "off",
            "@typescript-eslint/no-require-imports": "off",
            "@typescript-eslint/no-this-alias": "off",
            "@typescript-eslint/ban-ts-comment": "off",
            "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
        },
    },
    {
        files: ["test/**"],
        rules: { "@typescript-eslint/no-explicit-any": "off" },
    },
    {
        // CommonJS probe scripts.
        files: ["tools/**", "scripts/**"],
        rules: { "@typescript-eslint/no-require-imports": "off" },
    },
    {
        // The BOM in the regex is intentional.
        files: ["scripts/notices.mjs"],
        rules: { "no-irregular-whitespace": "off" },
    },
    prettier,
);

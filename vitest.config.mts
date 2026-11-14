import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Two projects, told apart by the file name:
//   unit         test/**/*.test.ts except *.integration.test.ts   npm test                  no Docker
//   integration  test/**/*.integration.test.ts                    npm run test:integration  needs Docker
// A test that needs a real database belongs in a *.integration.test.ts file.
export default defineConfig({
    resolve: {
        alias: {
            // Extension code imports "vscode", which only exists inside VS Code.
            vscode: fileURLToPath(new URL("./test/vscodeMock.ts", import.meta.url)),
            "extension-toolkit/base": fileURLToPath(
                new URL("./src/vendor/extension-toolkit/base/index.ts", import.meta.url),
            ),
            "extension-toolkit/vscode": fileURLToPath(
                new URL("./src/vendor/extension-toolkit/vscode/index.ts", import.meta.url),
            ),
        },
    },
    test: {
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["test/**/*.test.ts"],
                    exclude: ["test/**/*.integration.test.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["test/**/*.integration.test.ts"],
                    // Starts SQL Server and PostgreSQL with Testcontainers, removes them at the end.
                    globalSetup: ["test/support/globalSetup.ts"],
                    testTimeout: 30000,
                    hookTimeout: 30000,
                },
            },
        ],
    },
});

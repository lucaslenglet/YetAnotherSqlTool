// What scripts/test-vscode.mjs tells the tests about the VS Code they run in.

export interface TestProfile {
    id: string;
    profileName: string;
    provider: "mssql" | "pg";
    server: string;
    port?: number;
    database: string;
    user: string;
    password: string;
    /** Database filter of the profile, when it has one. */
    databaseFilter?: string;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set: these tests are started by \`npm run test:vscode\``);
    }
    return value;
}

const profiles: TestProfile[] = JSON.parse(required("YAST_TEST_PROFILES"));

export const env = {
    /** "<publisher>.<name>" of the extension under test. */
    extensionId: required("YAST_TEST_EXTENSION_ID"),
    /** Folder the .vsix was installed into. */
    installDir: required("YAST_TEST_INSTALL_DIR"),
    /** Port of the DevTools protocol of the test window. */
    debugPort: Number(required("YAST_TEST_DEBUG_PORT")),
    /** Where to leave DOM dumps when a test fails. */
    artifactsDir: required("YAST_TEST_ARTIFACTS"),
    /** settings.json of the user of the test window. */
    userSettingsFile: required("YAST_TEST_USER_SETTINGS"),
    /** Connection profiles written to the settings, in the order of the connection quick pick. */
    profiles,
};

export function profile(provider: TestProfile["provider"]): TestProfile {
    return profiles.find((p) => p.provider === provider)!;
}

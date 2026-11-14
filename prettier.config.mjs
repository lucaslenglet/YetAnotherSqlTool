// Same settings as Microsoft's vscode-mssql, so that the files copied from it stay (almost)
// byte-identical after formatting.
const config = {
    tabWidth: 4,
    printWidth: 100,
    bracketSameLine: true,
    endOfLine: "lf",
    overrides: [
        {
            files: ["*.yml", "*.yaml"],
            options: {
                tabWidth: 2,
            },
        },
    ],
};

export default config;

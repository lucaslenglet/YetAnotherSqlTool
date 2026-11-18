/**
 * Colors of the series of a chart, in order: VS Code's chart colors, which every theme (light,
 * dark, high contrast) defines. Red comes last: it reads as an error.
 */
const SERIES_COLORS = [
    "--vscode-charts-blue",
    "--vscode-charts-green",
    "--vscode-charts-yellow",
    "--vscode-charts-purple",
    "--vscode-charts-orange",
    "--vscode-charts-red",
];

export function seriesColorVariable(index: number): string {
    return SERIES_COLORS[index % SERIES_COLORS.length];
}

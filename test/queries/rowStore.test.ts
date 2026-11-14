import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellValue } from "../../src/drivers/types";
import {
    createRowStore,
    decodeRows,
    encodeRows,
    type RowFile,
    type RowFileProvider,
    type RowStore,
} from "../../src/queries/rowStore";
import { ResultFiles } from "../../src/queries/resultFiles";

const cell = (displayValue: string): CellValue => ({ displayValue, isNull: false });
const NULL: CellValue = { displayValue: "NULL", isNull: true };
const row = (n: number): CellValue[] => [
    cell(String(n)),
    cell(`row ${n}`),
    n % 7 === 0 ? NULL : cell("x"),
];
const rows = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => row(from + i));
const values = (r: CellValue[][]) =>
    r.map((cells) => cells.map((c) => (c.isNull ? null : c.displayValue)));

async function collect(iterable: AsyncIterable<CellValue[][]>): Promise<CellValue[][]> {
    const all: CellValue[][] = [];
    for await (const chunk of iterable) all.push(...chunk);
    return all;
}

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "yast-rows-"));
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/** Files under `root`, recursively. */
function filesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name));
}

/** A file in memory; `beforeWrite` can delay or fail writes. */
function memoryFiles(beforeWrite: () => Promise<void> = async () => undefined): RowFileProvider {
    return {
        async createFile(): Promise<RowFile> {
            let content = Buffer.alloc(0);
            return {
                path: "memory",
                async write(data, position) {
                    await beforeWrite();
                    const end = position + data.length;
                    if (end > content.length) {
                        const bigger = Buffer.alloc(end);
                        content.copy(bigger);
                        content = bigger;
                    }
                    content.set(data, position);
                },
                async read(length, position) {
                    return Buffer.from(content.subarray(position, position + length));
                },
                async remove() {},
            };
        },
    };
}

/** A store that spills almost at once, with small blocks, so that tests cross many blocks. */
function spillingStore(files: RowFileProvider, extra: object = {}): RowStore {
    return createRowStore({
        files,
        memoryLimit: 2000,
        blockMaxRows: 16,
        blockMaxBytes: 4096,
        readCacheBytes: 4096,
        ...extra,
    });
}

describe("row encoding", () => {
    it("round-trips unicode, NULL, the text NULL, empty strings and long texts", () => {
        const long = "é".repeat(300) + "日本\u{1F600}";
        const input = [
            [cell(""), NULL, cell("NULL"), cell("a\tb\r\nc")],
            [cell(long), cell("x".repeat(70_000)), cell("\u0000"), NULL],
            [],
        ];
        const out: CellValue[][] = [];
        decodeRows(encodeRows(input), 10, 10, 13, out);
        expect(out).toEqual(input);
    });

    it("decodes a window of rows inside a block", () => {
        const out: CellValue[][] = [];
        decodeRows(encodeRows(rows(100, 20)), 100, 105, 108, out);
        expect(values(out)).toEqual(values(rows(105, 3)));
    });
});

describe("RowStore in memory", () => {
    it("never creates a file for a small result", async () => {
        const files = new ResultFiles(path.join(root, "results"));
        const store = files.createRowStore();
        for (let i = 0; i < 100; i++) expect(store.append(rows(i * 10, 10))).toBeUndefined();
        expect(store.rowCount).toBe(1000);
        expect(values(await store.getRows(995, 10))).toEqual(values(rows(995, 5)));
        expect(fs.existsSync(path.join(root, "results"))).toBe(false);
        await store.dispose();
        expect(files.memory.used).toBe(0);
    });

    it("stays in memory without a file provider, whatever the size", async () => {
        const store = createRowStore({ memoryLimit: 10 });
        store.append(rows(0, 1000));
        expect(values(await store.getRows(999, 1))).toEqual(values([row(999)]));
    });

    it("spills when the budget shared by the window is used up", async () => {
        const files = new ResultFiles(path.join(root, "results"), { sharedMemoryLimit: 50_000 });
        const first = files.createRowStore();
        first.append(rows(0, 200)); // ~40 KB, fits
        const second = files.createRowStore();
        await second.append(rows(0, 200)); // over the shared budget
        await second.append(rows(200, 300)); // seals blocks, whose writes create the file
        while (filesUnder(files.sessionDir).length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(values(await second.getRows(0, 500))).toEqual(values(rows(0, 500)));
        await first.dispose();
        await second.dispose();
        expect(files.memory.used).toBe(0);
    });
});

describe("RowStore on disk", () => {
    it("spills to a private file and reads any page while appending and after", async () => {
        const files = new ResultFiles(path.join(root, "results"));
        // A low high-water mark makes appends wait for the disk, so that pages are read back from it.
        const store = spillingStore(files, { writeHighWater: 4096 });
        let appended = 0;
        while (appended < 5000) {
            await store.append(rows(appended, 37));
            appended += 37;
            // Start, middle, end, while still appending.
            expect(values(await store.getRows(0, 3))).toEqual(values(rows(0, 3)));
            const middle = Math.floor(appended / 2);
            expect(values(await store.getRows(middle, 50))).toEqual(
                values(rows(middle, Math.min(50, appended - middle))),
            );
            expect(values(await store.getRows(appended - 1, 50))).toEqual(
                values([row(appended - 1)]),
            );
        }
        expect(store.rowCount).toBe(appended);
        expect(await store.getRows(appended, 10)).toEqual([]);

        const [file] = filesUnder(files.sessionDir);
        expect(file).toBeDefined();
        if (process.platform !== "win32") {
            expect(fs.statSync(files.sessionDir).mode & 0o777).toBe(0o700);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }

        const all = await collect(store.iterate());
        expect(all).toHaveLength(appended);
        expect(values(all.slice(4990, 5000))).toEqual(values(rows(4990, 10)));
        expect(values(await collect(store.iterate(1234, 1300)))).toEqual(values(rows(1234, 66)));

        await store.dispose();
        expect(fs.existsSync(file)).toBe(false);
        expect(await store.getRows(0, 10)).toEqual([]);
    });

    it("keeps huge cells and every kind of value intact", async () => {
        const files = new ResultFiles(path.join(root, "results"));
        const store = spillingStore(files);
        const huge = "日".repeat(3_000_000) + "end";
        const special = [cell(""), NULL, cell("NULL"), cell(huge), cell("\u{1F600}")];
        await store.append(rows(0, 100));
        await store.append([special]);
        await store.append(rows(101, 100));
        const [read] = await store.getRows(100, 1);
        expect(read).toEqual(special);
        expect(values(await store.getRows(99, 3))).toEqual(values([row(99), special, row(101)]));
        await store.dispose();
    });

    it("asks the producer to wait while the disk is behind, and resumes once it caught up", async () => {
        let release: () => void = () => undefined;
        let writes = 0;
        const slowFiles = memoryFiles(async () => {
            await new Promise<void>((resolve) => (release = resolve));
            writes++;
        });
        const store = spillingStore(slowFiles, { writeHighWater: 2000 });
        let pending: void | Promise<void>;
        let appended = 0;
        do {
            pending = store.append(rows(appended, 16));
            appended += 16;
        } while (!pending && appended < 10_000);
        expect(pending).toBeInstanceOf(Promise);
        expect(appended).toBeLessThan(500);
        let settled = false;
        void (pending as Promise<void>).then(() => (settled = true));
        // Rows waiting for the disk are still readable.
        expect(values(await store.getRows(appended - 2, 2))).toEqual(values(rows(appended - 2, 2)));
        while (!settled) {
            release();
            await new Promise((resolve) => setImmediate(resolve));
        }
        expect(writes).toBeGreaterThan(0);
        // dispose waits for the write in progress.
        const releasing = setInterval(() => release(), 1);
        await store.dispose();
        clearInterval(releasing);
    });

    it("rejects further rows after a disk error and keeps the rows it has", async () => {
        let failAfter = 2;
        const failingFiles = memoryFiles(async () => {
            if (failAfter-- <= 0) {
                throw Object.assign(new Error("ENOSPC: no space left on device"), {
                    code: "ENOSPC",
                });
            }
        });
        const store = spillingStore(failingFiles, { writeHighWater: 100 });
        let error: unknown;
        try {
            for (let i = 0; i < 100; i++) await store.append(rows(i * 16, 16));
        } catch (e) {
            error = e;
        }
        expect(String(error)).toContain("ENOSPC");
        const count = store.rowCount;
        expect(values(await collect(store.iterate()))).toEqual(values(rows(0, count)));
        await expect(store.append(rows(count, 1))).rejects.toThrow("ENOSPC");
        await store.dispose();
    });

    it("reports a directory that cannot be created through append", async () => {
        const notADirectory = path.join(root, "file");
        fs.writeFileSync(notADirectory, "");
        const store = spillingStore(new ResultFiles(path.join(notADirectory, "results")), {
            writeHighWater: 100,
        });
        await expect(
            (async () => {
                for (let i = 0; i < 100; i++) await store.append(rows(i * 16, 16));
            })(),
        ).rejects.toThrow();
        expect(store.rowCount).toBeGreaterThan(0);
        expect(values(await store.getRows(0, 5))).toEqual(values(rows(0, 5)));
        await store.dispose();
    });
});

describe("ResultFiles", () => {
    it("removes the sessions of dead windows of this machine only", async () => {
        const results = path.join(root, "results");
        const mine = new ResultFiles(results, { pid: 100, hostname: "here" });
        const live = new ResultFiles(results, { pid: 200, hostname: "here" });
        const dead = new ResultFiles(results, { pid: 300, hostname: "here" });
        const elsewhere = new ResultFiles(results, { pid: 300, hostname: "there" });
        for (const files of [mine, live, dead, elsewhere]) await files.createFile();
        fs.mkdirSync(path.join(results, "unrelated"));

        const removed = await mine.removeStaleSessions((pid) => pid !== 300);
        expect(removed).toEqual([dead.sessionDir]);
        expect(fs.existsSync(dead.sessionDir)).toBe(false);
        for (const kept of [mine, live, elsewhere])
            expect(fs.existsSync(kept.sessionDir)).toBe(true);
        expect(fs.existsSync(path.join(results, "unrelated"))).toBe(true);

        // Deactivation: the files still open are closed, then the directory goes.
        await mine.removeSession();
        expect(fs.existsSync(mine.sessionDir)).toBe(false);
    });

    it("finds nothing to clean when the directory does not exist yet", async () => {
        expect(await new ResultFiles(path.join(root, "none")).removeStaleSessions()).toEqual([]);
    });
});

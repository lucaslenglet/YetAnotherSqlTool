/**
 * Rows of one result set, kept in memory while they are few and in a file beyond that.
 *
 * Plays the part of sqltoolsservice's ServiceBufferFileStream: a query returning millions of rows
 * must not keep them all in the extension host. A store starts in memory (small everyday results
 * never touch the disk); once it outgrows its budget, every row moves to an append-only file and
 * memory only holds an index, the rows waiting to be written and a small read cache.
 *
 * File format: a sequence of blocks, written once and never changed. A block holds consecutive
 * rows (at most BLOCK_MAX_ROWS of them, or about BLOCK_MAX_BYTES), each row being
 *   varint(cell count), then per cell varint(0) for NULL or varint(UTF-8 byte length + 1) + bytes.
 * The index keeps, per block, its first row number and its offset in the file (16 bytes per block,
 * about 3 MB for 50 million rows of 256-row blocks). Reading rows is a binary search in the index
 * plus one read of the block(s) that hold them, whatever the position in the result.
 *
 * No `vscode` import: the store is plain Node and tested as such.
 */

import type { CellValue } from "../drivers/types";

export interface RowStore {
    readonly rowCount: number;
    /**
     * Adds rows at the end. Returns a promise when the producer should wait before sending more
     * (backpressure): it settles once the rows waiting for the disk are back under the limit, and
     * rejects when the disk failed (the rows already stored stay readable).
     */
    append(rows: CellValue[][]): void | Promise<void>;
    /** Rows [start, start + count), fewer at the end. Safe while rows are still being appended. */
    getRows(start: number, count: number): Promise<CellValue[][]>;
    /** All rows of [start, end) in order, in chunks, without holding them all: for exports and summaries. */
    iterate(start?: number, end?: number): AsyncIterable<CellValue[][]>;
    /** Releases memory and deletes the file. */
    dispose(): Promise<void>;
}

/** A file a store writes its rows to: positioned reads and writes, as Node's FileHandle offers. */
export interface RowFile {
    readonly path: string;
    write(data: Uint8Array, position: number): Promise<void>;
    /** Reads exactly `length` bytes at `position`. */
    read(length: number, position: number): Promise<Buffer>;
    /** Closes and deletes the file. */
    remove(): Promise<void>;
}

/** Where stores create their files (see ResultFiles). */
export interface RowFileProvider {
    createFile(): Promise<RowFile>;
}

/** Memory that the in-memory stores of a window share, so that many medium results also spill. */
export class MemoryBudget {
    public used = 0;
    constructor(public readonly limit: number) {}
}

export interface RowStoreOptions {
    /** Where rows go beyond the memory budget; without it the store always stays in memory. */
    files?: RowFileProvider;
    /** Estimated bytes of rows this store may keep in memory before spilling to its file. */
    memoryLimit?: number;
    /** Budget shared with the other stores of the window. */
    sharedMemory?: MemoryBudget;
    blockMaxRows?: number;
    blockMaxBytes?: number;
    /** Bytes waiting for the disk beyond which `append` asks the producer to wait. */
    writeHighWater?: number;
    /** Bytes of recently read blocks kept to serve the next pages of the grid. */
    readCacheBytes?: number;
}

/**
 * 16 MiB of estimated memory per result set: about 100,000 rows of five short columns, far more
 * than everyday queries return, while a few dozen such results stay well under a hundred MB.
 */
export const DEFAULT_MEMORY_LIMIT = 16 * 1024 * 1024;
/** All in-memory stores of a window together. */
export const DEFAULT_SHARED_MEMORY_LIMIT = 128 * 1024 * 1024;
const BLOCK_MAX_ROWS = 256;
const BLOCK_MAX_BYTES = 1024 * 1024;
const WRITE_HIGH_WATER = 8 * 1024 * 1024;
const READ_CACHE_BYTES = 8 * 1024 * 1024;
/** Rows per chunk of `iterate`. */
const ITERATE_CHUNK_ROWS = 2048;
/** Consecutive blocks are read with one read up to this size. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export function createRowStore(options: RowStoreOptions = {}): RowStore {
    return new HybridRowStore(options);
}

/** Estimated heap size of a row: the cell objects, their strings and the array. */
function estimateRowBytes(row: CellValue[]): number {
    let bytes = 32 + row.length * 8;
    for (const cell of row) {
        bytes += 48 + cell.displayValue.length * 2;
    }
    return bytes;
}

class HybridRowStore implements RowStore {
    private _rowCount = 0;
    private disposed = false;

    // -- memory mode
    private memoryRows: CellValue[][] | undefined = [];
    private memoryBytes = 0;

    // -- file mode
    private file: Promise<RowFile> | undefined;
    /** First row and file offset of each sealed block; entries [0, blockCount) are valid. */
    private blockFirstRow = new Float64Array(64);
    private blockOffset = new Float64Array(64);
    private blockCount = 0;
    /** Rows in sealed blocks; the current rows follow. */
    private sealedRows = 0;
    /** Offset where the next block goes. */
    private fileEnd = 0;
    /** Sealed blocks not yet confirmed on disk, readable from here meanwhile. */
    private readonly unwritten = new Map<number, Buffer>();
    private unwrittenBytes = 0;
    /** Rows after the last sealed block. */
    private currentRows: CellValue[][] = [];
    private currentBytes = 0;
    private writeChain: Promise<void> = Promise.resolve();
    private writeError: Error | undefined;
    private drainWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
    private readonly cache = new Map<number, Buffer>();
    private cacheBytes = 0;

    private readonly memoryLimit: number;
    private readonly blockMaxRows: number;
    private readonly blockMaxBytes: number;
    private readonly writeHighWater: number;
    private readonly readCacheBytes: number;

    constructor(private readonly options: RowStoreOptions) {
        this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
        this.blockMaxRows = options.blockMaxRows ?? BLOCK_MAX_ROWS;
        this.blockMaxBytes = options.blockMaxBytes ?? BLOCK_MAX_BYTES;
        this.writeHighWater = options.writeHighWater ?? WRITE_HIGH_WATER;
        this.readCacheBytes = options.readCacheBytes ?? READ_CACHE_BYTES;
    }

    public get rowCount(): number {
        return this._rowCount;
    }

    public append(rows: CellValue[][]): void | Promise<void> {
        if (this.disposed || rows.length === 0) {
            return;
        }
        if (this.writeError) {
            return Promise.reject(this.writeError);
        }
        if (this.memoryRows) {
            let bytes = 0;
            for (const row of rows) bytes += estimateRowBytes(row);
            const shared = this.options.sharedMemory;
            const fits =
                this.memoryBytes + bytes <= this.memoryLimit &&
                (!shared || shared.used + bytes <= shared.limit);
            if (fits || !this.options.files) {
                for (const row of rows) this.memoryRows.push(row);
                this.memoryBytes += bytes;
                if (shared) shared.used += bytes;
                this._rowCount += rows.length;
                return;
            }
            this.startSpilling();
        }
        for (const row of rows) {
            this.currentRows.push(row);
            this.currentBytes += estimateRowBytes(row);
            this._rowCount++;
            if (
                this.currentRows.length >= this.blockMaxRows ||
                this.currentBytes >= this.blockMaxBytes
            ) {
                this.sealBlock();
            }
        }
        return this.backpressure();
    }

    /** Moves the rows kept in memory into blocks and opens the file they go to. */
    private startSpilling(): void {
        const rows = this.memoryRows!;
        this.memoryRows = undefined;
        this.releaseMemory();
        this.file = this.options.files!.createFile();
        // A failure to create the file surfaces through the first write.
        this.file.catch(() => undefined);
        for (const row of rows) {
            this.currentRows.push(row);
            this.currentBytes += estimateRowBytes(row);
            if (
                this.currentRows.length >= this.blockMaxRows ||
                this.currentBytes >= this.blockMaxBytes
            ) {
                this.sealBlock();
            }
        }
    }

    private releaseMemory(): void {
        if (this.options.sharedMemory) this.options.sharedMemory.used -= this.memoryBytes;
        this.memoryBytes = 0;
    }

    /** Encodes the current rows as a block, indexes it and queues its write. */
    private sealBlock(): void {
        if (this.currentRows.length === 0) return;
        const data = encodeRows(this.currentRows);
        const index = this.blockCount;
        if (index === this.blockOffset.length) {
            this.blockOffset = grow(this.blockOffset);
            this.blockFirstRow = grow(this.blockFirstRow);
        }
        this.blockFirstRow[index] = this.sealedRows;
        this.sealedRows += this.currentRows.length;
        this.blockOffset[index] = this.fileEnd;
        this.blockCount++;
        const position = this.fileEnd;
        this.fileEnd += data.length;
        this.currentRows = [];
        this.currentBytes = 0;

        this.unwritten.set(index, data);
        this.unwrittenBytes += data.length;
        const file = this.file!;
        this.writeChain = this.writeChain.then(async () => {
            if (this.writeError || this.disposed) return;
            try {
                await (await file).write(data, position);
                this.unwritten.delete(index);
                this.unwrittenBytes -= data.length;
            } catch (error) {
                // The block stays in `unwritten`: rows already shown remain readable.
                this.writeError = error instanceof Error ? error : new Error(String(error));
            }
            this.wakeWriters();
        });
    }

    private backpressure(): void | Promise<void> {
        if (this.unwrittenBytes <= this.writeHighWater && !this.writeError) {
            return;
        }
        return new Promise<void>((resolve, reject) => {
            this.drainWaiters.push({ resolve, reject });
            this.wakeWriters();
        });
    }

    private wakeWriters(): void {
        if (this.writeError) {
            const error = this.writeError;
            this.drainWaiters.splice(0).forEach((w) => w.reject(error));
        } else if (this.unwrittenBytes <= this.writeHighWater / 2 || this.disposed) {
            this.drainWaiters.splice(0).forEach((w) => w.resolve());
        }
    }

    public async getRows(start: number, count: number): Promise<CellValue[][]> {
        const end = Math.min(start + Math.max(count, 0), this._rowCount);
        start = Math.max(start, 0);
        if (this.disposed || start >= end) {
            return [];
        }
        if (this.memoryRows) {
            return this.memoryRows.slice(start, end);
        }
        const result: CellValue[][] = [];
        const sealedEnd = this.sealedRows;
        // Rows of the current block are captured now: sealing must not move them under our feet.
        const currentFirst = sealedEnd;
        const current = this.currentRows;
        if (start < sealedEnd) {
            try {
                await this.readSealed(start, Math.min(end, sealedEnd), result);
            } catch (error) {
                // Disposed meanwhile: the file is gone, and so is the result set.
                if (this.disposed) return [];
                throw error;
            }
        }
        for (let row = Math.max(start, currentFirst); row < end; row++) {
            const cells = current[row - currentFirst];
            if (!cells) break;
            result.push(cells);
        }
        return this.disposed ? [] : result;
    }

    /** Appends to `out` the rows [start, end) of sealed blocks. */
    private async readSealed(start: number, end: number, out: CellValue[][]): Promise<void> {
        let block = this.findBlock(start);
        const lastBlock = this.findBlock(end - 1);
        while (block <= lastBlock) {
            // One read for consecutive blocks that are on disk and not cached, up to MAX_READ_BYTES.
            let runEnd = block;
            if (this.blockData(block) === undefined) {
                while (
                    runEnd + 1 <= lastBlock &&
                    this.blockData(runEnd + 1) === undefined &&
                    this.blockEnd(runEnd + 1) - this.blockOffset[block] <= MAX_READ_BYTES
                ) {
                    runEnd++;
                }
            }
            const buffers = await this.loadBlocks(block, runEnd);
            for (let b = block; b <= runEnd; b++) {
                const first = this.blockFirstRow[b];
                decodeRows(buffers[b - block], first, Math.max(start, first), end, out);
            }
            block = runEnd + 1;
        }
    }

    private findBlock(row: number): number {
        let low = 0;
        let high = this.blockCount - 1;
        while (low < high) {
            const mid = (low + high + 1) >>> 1;
            if (this.blockFirstRow[mid] <= row) low = mid;
            else high = mid - 1;
        }
        return low;
    }

    private blockEnd(index: number): number {
        return index + 1 < this.blockCount ? this.blockOffset[index + 1] : this.fileEnd;
    }

    /** Bytes of a block already in memory (not yet written, or cached). */
    private blockData(index: number): Buffer | undefined {
        return this.unwritten.get(index) ?? this.cache.get(index);
    }

    private async loadBlocks(first: number, last: number): Promise<Buffer[]> {
        const inMemory = this.blockData(first);
        if (first === last && inMemory) {
            if (this.cache.has(first)) {
                // Most recently used goes last.
                this.cache.delete(first);
                this.cache.set(first, inMemory);
            }
            return [inMemory];
        }
        const position = this.blockOffset[first];
        const data = await (await this.file!).read(this.blockEnd(last) - position, position);
        const buffers: Buffer[] = [];
        for (let b = first; b <= last; b++) {
            const block = data.subarray(
                this.blockOffset[b] - position,
                this.blockEnd(b) - position,
            );
            buffers.push(block);
            this.remember(b, block);
        }
        return buffers;
    }

    private remember(index: number, data: Buffer): void {
        if (data.length > this.readCacheBytes / 4) return;
        // A copy, so that the cache does not keep a whole multi-block read alive.
        const copy = Buffer.from(data);
        this.cache.set(index, copy);
        this.cacheBytes += copy.length;
        for (const [key, value] of this.cache) {
            if (this.cacheBytes <= this.readCacheBytes) break;
            this.cache.delete(key);
            this.cacheBytes -= value.length;
        }
    }

    public async *iterate(
        start = 0,
        end: number = Number.POSITIVE_INFINITY,
    ): AsyncIterable<CellValue[][]> {
        for (let row = Math.max(start, 0); row < Math.min(end, this._rowCount);) {
            const rows = await this.getRows(
                row,
                Math.min(ITERATE_CHUNK_ROWS, Math.min(end, this._rowCount) - row),
            );
            if (rows.length === 0) return;
            yield rows;
            row += rows.length;
        }
    }

    public async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        if (this.memoryRows) {
            this.releaseMemory();
            this.memoryRows = undefined;
        }
        this.currentRows = [];
        this.unwritten.clear();
        this.unwrittenBytes = 0;
        this.cache.clear();
        this.cacheBytes = 0;
        this.wakeWriters();
        if (this.file) {
            const file = this.file;
            await this.writeChain;
            try {
                await (await file).remove();
            } catch {
                // The file could not be created: nothing to delete.
            }
        }
    }
}

function grow(array: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
    const bigger = new Float64Array(array.length * 2);
    bigger.set(array);
    return bigger;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Reused to encode blocks; a block larger than that (huge cells) gets a buffer of its own. */
const SCRATCH_BYTES = 2 * 1024 * 1024;
let scratch: Buffer | undefined;

/** Encodes rows into a new buffer (format in the header comment). */
export function encodeRows(rows: CellValue[][]): Buffer {
    let length = 0;
    for (const row of rows) {
        length += 5;
        for (const cell of row) {
            const size = cell.displayValue.length;
            // Upper bound for short texts (3 bytes per UTF-16 unit), exact size for long ones.
            length += cell.isNull
                ? 1
                : 5 + (size < 1024 ? size * 3 : Buffer.byteLength(cell.displayValue, "utf8"));
        }
    }
    const buffer =
        length <= SCRATCH_BYTES
            ? (scratch ??= Buffer.allocUnsafe(SCRATCH_BYTES))
            : Buffer.allocUnsafe(length);
    let position = 0;
    for (const row of rows) {
        position = writeVarint(buffer, position, row.length);
        for (const cell of row) {
            if (cell.isNull) {
                buffer[position++] = 0;
                continue;
            }
            const text = cell.displayValue;
            if (text.length < 64) {
                // Short text: write it first, then the length in front (1 byte for < 127).
                const written = buffer.write(text, position + 1, "utf8");
                if (written + 1 < 0x80) {
                    buffer[position] = written + 1;
                    position += 1 + written;
                    continue;
                }
            }
            const byteLength = Buffer.byteLength(text, "utf8");
            position = writeVarint(buffer, position, byteLength + 1);
            position += buffer.write(text, position, "utf8");
        }
    }
    // A buffer of its own is nearly exact: no second copy of huge cells.
    return buffer === scratch
        ? Buffer.from(buffer.subarray(0, position))
        : buffer.subarray(0, position);
}

/** Decodes the rows [from, to) of a block whose first row is `firstRow`, appending them to `out`. */
export function decodeRows(
    data: Buffer,
    firstRow: number,
    from: number,
    to: number,
    out: CellValue[][],
): void {
    let position = 0;
    for (let row = firstRow; row < to && position < data.length; row++) {
        const cellCount = readVarint(data, position);
        position = varintEnd;
        const keep = row >= from;
        const cells: CellValue[] = keep ? new Array(cellCount) : [];
        for (let i = 0; i < cellCount; i++) {
            const header = readVarint(data, position);
            position = varintEnd;
            if (header === 0) {
                if (keep) cells[i] = { displayValue: "NULL", isNull: true };
                continue;
            }
            const end = position + header - 1;
            if (keep)
                cells[i] = { displayValue: data.toString("utf8", position, end), isNull: false };
            position = end;
        }
        if (keep) out.push(cells);
    }
}

function writeVarint(buffer: Buffer, position: number, value: number): number {
    while (value >= 0x80) {
        buffer[position++] = (value % 0x80) | 0x80;
        value = Math.floor(value / 0x80);
    }
    buffer[position++] = value;
    return position;
}

/** Position after the last varint read (avoids allocating a result object per cell). */
let varintEnd = 0;

function readVarint(buffer: Buffer, position: number): number {
    let value = 0;
    let factor = 1;
    while (true) {
        const byte = buffer[position++];
        value += (byte & 0x7f) * factor;
        if (byte < 0x80) break;
        factor *= 0x80;
    }
    varintEnd = position;
    return value;
}

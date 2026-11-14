/**
 * Directory of the result files of this extension host (see rowStore.ts).
 *
 * Result rows that do not fit in memory are written under the extension's global storage, NOT in
 * the OS temp directory (often in RAM on Linux). Each extension host (one per VS Code window)
 * owns a session directory named after its host name and process id:
 *   <root>/<host>-<pid>-<random>/<n>.rows       directory 0700, files 0600
 * A file is deleted when its result set goes away, the session directory when the extension
 * deactivates. A window that crashed cannot clean up: at activation, session directories of this
 * machine whose process is gone are removed. A directory whose process still runs (another
 * window) is never touched, nor are directories of other machines (a home shared over the
 * network). A dead session whose process id has been reused by another process stays until a
 * later activation, which errs on the safe side.
 */

import { randomBytes, createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    DEFAULT_SHARED_MEMORY_LIMIT,
    MemoryBudget,
    createRowStore,
    type RowFile,
    type RowFileProvider,
    type RowStore,
    type RowStoreOptions,
} from "./rowStore";

const SESSION_NAME = /^([0-9a-f]{8})-(\d+)-[0-9a-f]{8}$/;

export interface ResultFilesOptions {
    /** Defaults to this process; tests simulate other windows. */
    pid?: number;
    hostname?: string;
    /** Store settings (memory budget...); tests lower them. */
    store?: Omit<RowStoreOptions, "files" | "sharedMemory">;
    sharedMemoryLimit?: number;
}

export class ResultFiles implements RowFileProvider {
    public readonly sessionDir: string;
    public readonly memory: MemoryBudget;
    private readonly hostKey: string;
    private created: Promise<void> | undefined;
    private fileCount = 0;
    /** Handles still open: closed at deactivation, before the directory goes (Windows cannot delete open files). */
    private readonly openFiles = new Set<fs.promises.FileHandle>();

    constructor(
        public readonly root: string,
        private readonly options: ResultFilesOptions = {},
    ) {
        this.hostKey = hostKeyOf(options.hostname ?? os.hostname());
        const pid = options.pid ?? process.pid;
        this.sessionDir = path.join(
            root,
            `${this.hostKey}-${pid}-${randomBytes(4).toString("hex")}`,
        );
        this.memory = new MemoryBudget(options.sharedMemoryLimit ?? DEFAULT_SHARED_MEMORY_LIMIT);
    }

    public createRowStore(): RowStore {
        return createRowStore({ ...this.options.store, files: this, sharedMemory: this.memory });
    }

    public async createFile(): Promise<RowFile> {
        // Created on the first file only: small results never touch the disk.
        this.created ??= (async () => {
            await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
            await fs.promises.mkdir(this.sessionDir, { mode: 0o700 });
        })();
        try {
            await this.created;
        } catch (error) {
            this.created = undefined;
            throw error;
        }
        const filePath = path.join(this.sessionDir, `${++this.fileCount}.rows`);
        // "wx+": never reuse an existing file.
        const handle = await fs.promises.open(filePath, "wx+", 0o600);
        this.openFiles.add(handle);
        return new NodeRowFile(filePath, handle, () => this.openFiles.delete(handle));
    }

    /**
     * Removes the session directories left by windows of this machine that are gone. Returns the
     * removed paths. Never fails: cleanup is best effort.
     */
    public async removeStaleSessions(
        isAlive: (pid: number) => boolean = isProcessAlive,
    ): Promise<string[]> {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(this.root);
        } catch {
            return [];
        }
        const removed: string[] = [];
        for (const entry of entries) {
            const match = SESSION_NAME.exec(entry);
            const dir = path.join(this.root, entry);
            if (!match || match[1] !== this.hostKey || dir === this.sessionDir) continue;
            if (isAlive(Number(match[2]))) continue;
            try {
                await fs.promises.rm(dir, { recursive: true, force: true });
                removed.push(dir);
            } catch {
                // Retried at the next activation.
            }
        }
        return removed;
    }

    /**
     * Deletes the session directory, at deactivation: closes the files still open (Node waits for
     * their reads and writes in progress), then removes everything.
     */
    public async removeSession(): Promise<void> {
        await Promise.all(
            [...this.openFiles].map((handle) => handle.close().catch(() => undefined)),
        );
        this.openFiles.clear();
        this.removeSessionSync();
    }

    /** Deletes the session directory at once (files left open are deleted too, except on Windows). */
    public removeSessionSync(): void {
        try {
            fs.rmSync(this.sessionDir, { recursive: true, force: true });
        } catch {
            // Removed at a later activation.
        }
    }
}

/** A short, file-name-safe key of the host name. */
function hostKeyOf(hostname: string): string {
    return createHash("sha256").update(hostname).digest("hex").slice(0, 8);
}

/** Signal 0 checks that a process exists; EPERM means it exists but belongs to someone else. */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

class NodeRowFile implements RowFile {
    constructor(
        public readonly path: string,
        private readonly handle: fs.promises.FileHandle,
        private readonly onClose: () => void,
    ) {}

    public async write(data: Uint8Array, position: number): Promise<void> {
        let offset = 0;
        while (offset < data.length) {
            const { bytesWritten } = await this.handle.write(
                data,
                offset,
                data.length - offset,
                position + offset,
            );
            offset += bytesWritten;
        }
    }

    public async read(length: number, position: number): Promise<Buffer> {
        const buffer = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
            const { bytesRead } = await this.handle.read(
                buffer,
                offset,
                length - offset,
                position + offset,
            );
            if (bytesRead === 0) throw new Error(`Unexpected end of ${this.path}`);
            offset += bytesRead;
        }
        return buffer;
    }

    public async remove(): Promise<void> {
        try {
            this.onClose();
            await this.handle.close();
        } finally {
            await fs.promises.rm(this.path, { force: true });
        }
    }
}

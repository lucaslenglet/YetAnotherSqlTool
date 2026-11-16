import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import {
    challengeMessage,
    ntlmV2Proof,
    parseAuthenticate,
    parseNegotiate,
    targetInfo,
    type NtlmAuthenticate,
    type NtlmNegotiate,
} from "./ntlm";
import { createSelfSignedCertificate } from "./selfSignedCertificate";

// A SQL Server stand-in that accepts Microsoft Entra ID logins, for tests. No local SQL Server
// takes an Entra ID token, and none can be told to misbehave (refuse encryption, ask for a token
// meant for another service). This speaks just enough TDS (MS-TDS 7.4 and 8.0) for tedious to
// log in the way it does on Azure SQL, and records what reached the server:
//
//   PRELOGIN            the server announces FEDAUTHREQUIRED and its encryption setting
//   TLS handshake       inside PRELOGIN messages (TDS 7.4), or before anything else ("Strict", TDS 8.0)
//   LOGIN7              with the FEDAUTH feature extension, no user name and no password
//   FEDAUTHINFO         the server names the token authority (STS URL) and the audience (SPN)
//   FEDAUTH token       the access token, checked by `rejectToken`
//                       (a SQL login has a user name and a password instead, checked by `sqlLogins`)
//   NTLM                a Windows login has no user name and no password in LOGIN7, only an NTLM
//                       NEGOTIATE in its SSPI field; the server answers with an SSPI token (the
//                       challenge), the client sends NTLM AUTHENTICATE, checked against `windowsLogins`
//   LOGINACK, DONE      then SQL batches and sp_executesql calls are answered by `answer`
//
// With `redirectTo`, the login ends with a routing instruction instead, as Azure SQL's gateway
// does under the "Redirect" connection policy: the client then logs in again on the other server.
//
// It validates nothing the way Azure does (signature, audience, expiry of the token): what it
// proves is which bytes the client sends, when, and over what.

const PACKET = {
    SQL_BATCH: 0x01,
    RPC: 0x03,
    RESPONSE: 0x04,
    ATTENTION: 0x06,
    FEDAUTH_TOKEN: 0x08,
    LOGIN7: 0x10,
    NTLM_AUTH: 0x11,
    PRELOGIN: 0x12,
};
const PACKET_SIZE = 4096;
const HEADER_SIZE = 8;
const END_OF_MESSAGE = 0x01;

const PRELOGIN_OPTION = {
    VERSION: 0x00,
    ENCRYPTION: 0x01,
    INSTANCE: 0x02,
    THREAD_ID: 0x03,
    MARS: 0x04,
    FEDAUTH_REQUIRED: 0x06,
    TERMINATOR: 0xff,
};
const ENCRYPT_ON = 0x01;
const ENCRYPT_NOT_SUPPORTED = 0x02;

const FEATURE_FEDAUTH = 0x02;
const FEDAUTH_LIBRARY = { SECURITY_TOKEN: 0x01, MSAL: 0x02 };

const TOKEN = {
    RETURN_STATUS: 0x79,
    COL_METADATA: 0x81,
    ERROR: 0xaa,
    LOGIN_ACK: 0xad,
    FEATURE_EXT_ACK: 0xae,
    SSPI: 0xed,
    ROW: 0xd1,
    ENV_CHANGE: 0xe3,
    FEDAUTH_INFO: 0xee,
    DONE: 0xfd,
    DONE_PROC: 0xfe,
    DONE_IN_PROC: 0xff,
};
const DONE_FINAL = 0x0000;
const DONE_ERROR = 0x0002;
const DONE_MORE = 0x0001;
const DONE_COUNT = 0x0010;
const DONE_ATTENTION = 0x0020;

const TYPE_INT_N = 0x26;
const TYPE_NVARCHAR = 0xe7;
/** SQL_Latin1_General_CP1_CI_AS */
const COLLATION = Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34]);

const TLS_RECORD = { CHANGE_CIPHER_SPEC: 20, ALERT: 21, HANDSHAKE: 22 };
const TLS_SERVER_HELLO_DONE = 14;

/** Rows answered to a query. A column is nvarchar, or int when its name ends with ":int". */
export interface FakeResultSet {
    columns: string[];
    rows: (string | number | null)[][];
}

/** A server error answered to a query instead of rows. */
export interface FakeServerError {
    error: string;
    number: number;
}

/** One physical connection that sent a LOGIN7 message. */
export interface FakeTdsLogin {
    /** True when the login arrived inside TLS. */
    encrypted: boolean;
    /** True when the connection opened with TLS (encrypt: "Strict", TDS 8.0) instead of negotiating it. */
    tlsFirst: boolean;
    /** Protocol version the client asked for, e.g. "7.4". */
    tdsVersion: string;
    hostName: string;
    userName: string;
    /** True when the login carried a password. */
    hasPassword: boolean;
    /** The password, unscrambled: the protocol only hides it from a casual look. */
    password: string;
    appName: string;
    serverName: string;
    database: string;
    readOnlyIntent: boolean;
    /** FEDAUTH feature extension of the login, absent for a SQL login. */
    fedAuth?: {
        library: "MSAL" | "SecurityToken" | number;
        echo: boolean;
        workflow?: "integrated" | "userPassword";
    };
    /** Access token of the FEDAUTH token message, exactly as received. */
    token?: string;
    /** Windows (NTLM) login: what the client sent in the SSPI field of LOGIN7, then in NTLM AUTHENTICATE. */
    ntlm?: {
        negotiate: NtlmNegotiate;
        /** The challenge the server sent. */
        serverChallenge: Buffer;
        /** Absent until the client answers the challenge. */
        authenticate?: NtlmAuthenticate;
        /** True when the NTLMv2 response matches the password known for the account. */
        proofValid?: boolean;
    };
    /** True once the server sent LOGINACK. */
    accepted: boolean;
    /** Text of the SQL batches and sp_executesql calls received after the login. */
    requests: string[];
}

export interface FakeTdsServerOptions {
    /** PRELOGIN answer, see FakeTdsServer.encryption. Default "on". */
    encryption?: "on" | "notSupported";
    /** Audience the server asks a token for (FEDAUTHINFO SPN). Default: Azure SQL's. */
    spn?: string;
    /** Token authority the server announces (FEDAUTHINFO STSURL). */
    stsUrl?: string;
    /** What the server says about itself in the driver's server information query. */
    identity?: Partial<ServerIdentity>;
}

interface ServerIdentity {
    serverName: string;
    version: string;
    edition: string;
    /** 3 = Enterprise/Developer (on premises), 5 = Azure SQL Database. */
    engineEdition: number;
    loginName: string;
}

export class FakeTdsServer {
    /** Every login received, in order. */
    readonly logins: FakeTdsLogin[] = [];
    /** Returns the "Login failed" message for a token the server refuses, nothing for one it accepts. */
    rejectToken: (token: string, login: FakeTdsLogin) => string | undefined = () => undefined;
    /** SQL logins the server accepts: password by user name. */
    readonly sqlLogins = new Map<string, string>();
    /** Windows accounts the server accepts through NTLM: password by "DOMAIN\\user" (or "user@domain" with no domain), in any case. */
    readonly windowsLogins = new Map<string, string>();
    /** Number of coming logins to refuse with error 40613 ("database not currently available"), which clients retry. */
    transientFailures = 0;
    /** PRELOGIN answer; "notSupported" makes the server refuse TLS, as a downgrade attack would. */
    encryption: "on" | "notSupported";
    /** Answers a query; when it returns nothing, the built-in answers apply (server information, empty result). */
    answer: (sql: string, login: FakeTdsLogin) => FakeResultSet | FakeServerError | undefined =
        () => undefined;
    /** Returns the "Login failed" message for a login the server refuses after authenticating it (e.g. by its database). */
    refuseLogin: (login: FakeTdsLogin) => string | undefined = () => undefined;
    /** When set, an accepted login is sent to this other server. */
    redirectTo: { host: string; port: number } | undefined;

    readonly spn: string;
    readonly stsUrl: string;
    readonly identity: ServerIdentity;
    /** The server's certificate (PEM), self-signed for localhost and 127.0.0.1. */
    readonly certificate: string;

    private readonly secureContext: SecureContext;
    private readonly sockets = new Set<Socket>();
    private server: Server | undefined;

    constructor(options: FakeTdsServerOptions = {}) {
        this.encryption = options.encryption ?? "on";
        this.spn = options.spn ?? "https://database.windows.net/";
        this.stsUrl =
            options.stsUrl ?? "https://login.windows.net/00000000-0000-0000-0000-000000000000";
        this.identity = {
            serverName: "fake-azure-sql",
            version: "12.0.2000.8",
            edition: "SQL Azure",
            engineEdition: 5,
            loginName: "someone@contoso.com",
            ...options.identity,
        };
        const { cert, key } = createSelfSignedCertificate();
        this.certificate = cert;
        // SQL Server negotiates TLS 1.2 inside TDS 7.4; TLS 1.3 needs TDS 8.0.
        this.secureContext = createSecureContext({ cert, key, maxVersion: "TLSv1.2" });
    }

    get port(): number {
        return (this.server!.address() as AddressInfo).port;
    }

    /** Tokens received, one per login that got as far as sending one. */
    get tokens(): string[] {
        return this.logins.flatMap((login) => (login.token === undefined ? [] : [login.token]));
    }

    async start(): Promise<this> {
        this.server = createServer((socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
            new FakeTdsSession(this, socket, this.secureContext);
        });
        await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
        return this;
    }

    /** Closes every open connection, as Azure does with idle ones; the server keeps listening. */
    dropConnections(): void {
        for (const socket of this.sockets) socket.destroy();
    }

    async stop(): Promise<void> {
        this.dropConnections();
        await new Promise<void>((resolve) =>
            this.server ? this.server.close(() => resolve()) : resolve(),
        );
    }

    /** Built-in answers: what the mssql driver asks when it connects, and an empty result for the rest. */
    defaultAnswer(sql: string, login: FakeTdsLogin): FakeResultSet | undefined {
        if (sql.includes("SERVERPROPERTY('EngineEdition')")) {
            const { serverName, version, edition, engineEdition } = this.identity;
            const { domain, userName } = login.ntlm?.authenticate ?? {};
            const loginName = userName
                ? domain
                    ? `${domain}\\${userName}`
                    : userName
                : this.identity.loginName;
            return {
                columns: ["serverName", "version", "edition", "engineEdition:int", "loginName"],
                rows: [[serverName, version, edition, engineEdition, loginName]],
            };
        }
        if (/^\s*SELECT DB_NAME\(\)/i.test(sql))
            return { columns: ["name"], rows: [[login.database || "master"]] };
        if (/^\s*(set|use)\s/i.test(sql)) return undefined;
        return { columns: ["value"], rows: [] };
    }
}

/** Reassembles TDS messages from a byte stream: packets of at most PACKET_SIZE bytes, the last one flagged. */
class MessageReader {
    private buffered: Buffer = Buffer.alloc(0);
    private parts: Buffer[] = [];

    constructor(private readonly onMessage: (type: number, payload: Buffer) => void) {}

    push(chunk: Buffer): void {
        this.buffered = Buffer.concat([this.buffered, chunk]);
        while (this.buffered.length >= HEADER_SIZE) {
            const length = this.buffered.readUInt16BE(2);
            if (length < HEADER_SIZE || this.buffered.length < length) return;
            const packet = this.buffered.subarray(0, length);
            this.buffered = this.buffered.subarray(length);
            this.parts.push(packet.subarray(HEADER_SIZE));
            if (packet[1] & END_OF_MESSAGE) {
                const payload = Buffer.concat(this.parts);
                this.parts = [];
                this.onMessage(packet[0], payload);
            }
        }
    }
}

function toPackets(type: number, payload: Buffer): Buffer {
    const packets: Buffer[] = [];
    const chunkSize = PACKET_SIZE - HEADER_SIZE;
    for (
        let offset = 0, id = 1;
        offset === 0 || offset < payload.length;
        offset += chunkSize, id++
    ) {
        const chunk = payload.subarray(offset, offset + chunkSize);
        const header = Buffer.alloc(HEADER_SIZE);
        header[0] = type;
        header[1] = offset + chunkSize >= payload.length ? END_OF_MESSAGE : 0;
        header.writeUInt16BE(HEADER_SIZE + chunk.length, 2);
        header[6] = id % 256;
        packets.push(header, chunk);
    }
    return Buffer.concat(packets);
}

// -- Encoders of the few data stream tokens the server sends ------------------------------------

const ucs2 = (text: string) => Buffer.from(text, "ucs2");
const uint8 = (value: number) => Buffer.from([value]);
function uint16(value: number): Buffer {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    return buffer;
}
function uint32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
}
/** B_VARCHAR: length in characters on one byte. */
const shortText = (text: string) => Buffer.concat([uint8(text.length), ucs2(text)]);
/** US_VARCHAR: length in characters on two bytes. */
const longText = (text: string) => Buffer.concat([uint16(text.length), ucs2(text)]);
/** A token whose length is written on two bytes after its type. */
const sizedToken = (type: number, ...content: Buffer[]) => {
    const body = Buffer.concat(content);
    return Buffer.concat([uint8(type), uint16(body.length), body]);
};

function doneToken(type: number, status: number, rowCount = 0): Buffer {
    const rows = Buffer.alloc(8);
    rows.writeBigUInt64LE(BigInt(rowCount));
    return Buffer.concat([uint8(type), uint16(status), uint16(0), rows]);
}

/** Undoes the scrambling of the password of a LOGIN7 message: XOR with 0xA5, then swap the two halves of each byte. */
function unscramble(password: Buffer): string {
    return Buffer.from(
        password.map((byte) => (((byte ^ 0xa5) << 4) & 0xf0) | ((byte ^ 0xa5) >> 4)),
    ).toString("ucs2");
}

function errorToken(number: number, message: string, serverName: string): Buffer {
    const [state, severity, line] = [1, 14, 1];
    return sizedToken(
        TOKEN.ERROR,
        uint32(number),
        uint8(state),
        uint8(severity),
        longText(message),
        shortText(serverName),
        shortText(""),
        uint32(line),
    );
}

function fedAuthInfoToken(stsUrl: string, spn: string): Buffer {
    const values = [
        { id: 0x01, data: ucs2(stsUrl) },
        { id: 0x02, data: ucs2(spn) },
    ];
    // Offsets count from the start of the token's data, which begins with the number of values.
    let dataOffset = 4 + values.length * 9;
    const entries = values.map(({ id, data }) => {
        const entry = Buffer.concat([uint8(id), uint32(data.length), uint32(dataOffset)]);
        dataOffset += data.length;
        return entry;
    });
    const body = Buffer.concat([
        uint32(values.length),
        ...entries,
        ...values.map((value) => value.data),
    ]);
    return Buffer.concat([uint8(TOKEN.FEDAUTH_INFO), uint32(body.length), body]);
}

function resultSetTokens(result: FakeResultSet): Buffer {
    const columns = result.columns.map((column) => ({
        name: column.replace(/:int$/, ""),
        isInt: column.endsWith(":int"),
    }));
    const nullable = uint16(0x0001);
    const metadata = columns.map(({ name, isInt }) =>
        Buffer.concat([
            uint32(0), // user type
            nullable,
            isInt
                ? Buffer.from([TYPE_INT_N, 4])
                : Buffer.concat([uint8(TYPE_NVARCHAR), uint16(8000), COLLATION]),
            shortText(name),
        ]),
    );
    const rows = result.rows.map((row) =>
        Buffer.concat([
            uint8(TOKEN.ROW),
            ...row.map((value, index) => {
                if (columns[index].isInt) {
                    if (value === null) return uint8(0);
                    const data = Buffer.alloc(5);
                    data[0] = 4;
                    data.writeInt32LE(Number(value), 1);
                    return data;
                }
                if (value === null) return uint16(0xffff);
                const data = ucs2(String(value));
                return Buffer.concat([uint16(data.length), data]);
            }),
        ]),
    );
    return Buffer.concat([uint8(TOKEN.COL_METADATA), uint16(columns.length), ...metadata, ...rows]);
}

// -- Decoders of what the client sends ----------------------------------------------------------

function parsePrelogin(payload: Buffer): Map<number, Buffer> {
    const options = new Map<number, Buffer>();
    for (
        let offset = 0;
        offset < payload.length && payload[offset] !== PRELOGIN_OPTION.TERMINATOR;
        offset += 5
    ) {
        const dataOffset = payload.readUInt16BE(offset + 1);
        options.set(
            payload[offset],
            payload.subarray(dataOffset, dataOffset + payload.readUInt16BE(offset + 3)),
        );
    }
    return options;
}

function buildPrelogin(options: [number, Buffer][]): Buffer {
    const headerSize = options.length * 5 + 1;
    const header = Buffer.alloc(headerSize);
    let dataOffset = headerSize;
    options.forEach(([option, data], index) => {
        header[index * 5] = option;
        header.writeUInt16BE(dataOffset, index * 5 + 1);
        header.writeUInt16BE(data.length, index * 5 + 3);
        dataOffset += data.length;
    });
    header[headerSize - 1] = PRELOGIN_OPTION.TERMINATOR;
    return Buffer.concat([header, ...options.map(([, data]) => data)]);
}

function parseLogin(payload: Buffer, encrypted: boolean, tlsFirst: boolean): FakeTdsLogin {
    // Variable-length fields are (offset, length in characters) pairs starting at byte 36.
    const text = (field: number) =>
        payload.toString(
            "ucs2",
            payload.readUInt16LE(field),
            payload.readUInt16LE(field) + payload.readUInt16LE(field + 2) * 2,
        );
    const tdsVersion = payload.readUInt32LE(4);
    const login: FakeTdsLogin = {
        encrypted,
        tlsFirst,
        tdsVersion:
            tdsVersion === 0x08000000
                ? "8.0"
                : tdsVersion === 0x74000004
                  ? "7.4"
                  : `0x${tdsVersion.toString(16)}`,
        hostName: text(36),
        userName: text(40),
        hasPassword: payload.readUInt16LE(46) > 0,
        password: unscramble(
            payload.subarray(
                payload.readUInt16LE(44),
                payload.readUInt16LE(44) + payload.readUInt16LE(46) * 2,
            ),
        ),
        appName: text(48),
        serverName: text(52),
        database: text(68),
        readOnlyIntent: (payload[26] & 0x20) !== 0,
        accepted: false,
        requests: [],
    };

    const sspiLength = payload.readUInt16LE(80);
    if (sspiLength > 0) {
        const sspi = payload.subarray(
            payload.readUInt16LE(78),
            payload.readUInt16LE(78) + sspiLength,
        );
        login.ntlm = { negotiate: parseNegotiate(sspi), serverChallenge: Buffer.alloc(0) };
    }

    const hasExtension = (payload[27] & 0x10) !== 0;
    if (hasExtension) {
        // The extension field holds the offset of the feature list, which ends the message.
        let offset = payload.readUInt32LE(payload.readUInt16LE(56));
        while (offset < payload.length && payload[offset] !== 0xff) {
            const length = payload.readUInt32LE(offset + 1);
            const data = payload.subarray(offset + 5, offset + 5 + length);
            if (payload[offset] === FEATURE_FEDAUTH) {
                const library = data[0] >> 1;
                const echo = (data[0] & 0x01) !== 0;
                if (library === FEDAUTH_LIBRARY.MSAL) {
                    login.fedAuth = {
                        library: "MSAL",
                        echo,
                        workflow: data[1] === 0x02 ? "integrated" : "userPassword",
                    };
                } else if (library === FEDAUTH_LIBRARY.SECURITY_TOKEN) {
                    login.fedAuth = { library: "SecurityToken", echo };
                    login.token = data.toString("ucs2", 5, 5 + data.readUInt32LE(1));
                } else {
                    login.fedAuth = { library, echo };
                }
            }
            offset += 5 + length;
        }
    }
    return login;
}

/** Skips the ALL_HEADERS block that starts SQL batch and RPC messages. */
const afterHeaders = (payload: Buffer) => payload.subarray(payload.readUInt32LE(0));

/** Statement of an sp_executesql call: its first parameter, an nvarchar. */
function rpcStatement(payload: Buffer): string {
    const body = afterHeaders(payload);
    const nameLength = body.readUInt16LE(0);
    // 0xFFFF announces a well-known procedure number instead of a name.
    let offset = nameLength === 0xffff ? 4 : 2 + nameLength * 2;
    offset += 2; // option flags
    offset += 1 + body[offset] * 2; // parameter name
    offset += 1; // status flags
    if (body[offset] !== TYPE_NVARCHAR) return "";
    const maxLength = body.readUInt16LE(offset + 1);
    offset += 3 + COLLATION.length;
    if (maxLength !== 0xffff)
        return body.toString("ucs2", offset + 2, offset + 2 + body.readUInt16LE(offset));
    // nvarchar(max): total length on 8 bytes, then chunks, each with its length, until an empty one.
    offset += 8;
    const chunks: Buffer[] = [];
    for (let length = body.readUInt32LE(offset); length > 0; length = body.readUInt32LE(offset)) {
        chunks.push(body.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
    }
    return Buffer.concat(chunks).toString("ucs2");
}

/**
 * Tells whether the TLS records the server is about to send make a whole flight of the TLS 1.2
 * handshake. tedious expects each flight in exactly one TDS message: "more" for the first one
 * (ends with ServerHelloDone), "last" for the second (ChangeCipherSpec then Finished) or an alert.
 */
function handshakeFlight(records: Buffer): "incomplete" | "more" | "last" {
    const handshakeMessages: Buffer[] = [];
    let cipherChanged = false;
    let finished = false;
    let offset = 0;
    while (offset + 5 <= records.length) {
        const length = records.readUInt16BE(offset + 3);
        if (offset + 5 + length > records.length) return "incomplete";
        const body = records.subarray(offset + 5, offset + 5 + length);
        if (records[offset] === TLS_RECORD.ALERT) return "last";
        if (records[offset] === TLS_RECORD.CHANGE_CIPHER_SPEC) cipherChanged = true;
        else if (records[offset] === TLS_RECORD.HANDSHAKE && cipherChanged) finished = true;
        else if (records[offset] === TLS_RECORD.HANDSHAKE) handshakeMessages.push(body);
        offset += 5 + length;
    }
    if (offset !== records.length) return "incomplete";
    if (cipherChanged) return finished ? "last" : "incomplete";

    const messages = Buffer.concat(handshakeMessages);
    for (
        let position = 0;
        position + 4 <= messages.length;
        position += 4 + messages.readUIntBE(position + 1, 3)
    ) {
        if (messages[position] === TLS_SERVER_HELLO_DONE) return "more";
    }
    return "incomplete";
}

/** One client connection, from its first byte to its end. */
class FakeTdsSession {
    private login: FakeTdsLogin | undefined;
    /** "none": TDS on the socket. "handshake": TLS records travel inside PRELOGIN messages. "raw": TLS on the socket. */
    private tlsState: "none" | "handshake" | "raw" = "none";
    private started = false;
    private strict = false;
    private tlsSocket: TLSSocket | undefined;
    /** What the TLS layer reads from and writes to, in place of the socket. */
    private tlsTransport: Duplex | undefined;
    private pendingFlight: Buffer = Buffer.alloc(0);
    private readonly plainMessages = new MessageReader((type, payload) =>
        this.onMessage(type, payload),
    );

    constructor(
        private readonly server: FakeTdsServer,
        private readonly socket: Socket,
        private readonly secureContext: SecureContext,
    ) {
        socket.on("error", () => undefined);
        socket.on("close", () => this.tlsSocket?.destroy());
        socket.on("data", (chunk) => this.onSocketData(chunk));
    }

    private onSocketData(chunk: Buffer): void {
        if (!this.started) {
            this.started = true;
            // TDS 8.0 (encrypt: "Strict") opens with a TLS ClientHello instead of a PRELOGIN packet.
            if (chunk[0] === TLS_RECORD.HANDSHAKE) {
                this.strict = true;
                this.startTls("raw");
            }
        }
        if (this.tlsState === "raw") this.tlsTransport!.push(chunk);
        else this.plainMessages.push(chunk);
    }

    private startTls(state: "handshake" | "raw"): void {
        this.tlsState = state;
        this.tlsTransport = new Duplex({
            read: () => undefined,
            write: (chunk: Buffer, _encoding, callback) => {
                this.onTlsOutput(chunk);
                callback();
            },
        });
        this.tlsSocket = new TLSSocket(this.tlsTransport, {
            isServer: true,
            secureContext: this.secureContext,
            ALPNProtocols: this.strict ? ["tds/8.0"] : undefined,
        });
        const secureMessages = new MessageReader((type, payload) => this.onMessage(type, payload));
        this.tlsSocket.on("data", (chunk) => secureMessages.push(chunk));
        this.tlsSocket.on("error", () => this.socket.destroy());
    }

    private onTlsOutput(records: Buffer): void {
        if (this.tlsState === "raw") {
            this.socket.write(records);
            return;
        }
        this.pendingFlight = Buffer.concat([this.pendingFlight, records]);
        const flight = handshakeFlight(this.pendingFlight);
        if (flight === "incomplete") return;
        this.socket.write(toPackets(PACKET.PRELOGIN, this.pendingFlight));
        this.pendingFlight = Buffer.alloc(0);
        // The handshake is over: from now on TLS records go on the socket as they are.
        if (flight === "last") this.tlsState = "raw";
    }

    private send(...tokens: Buffer[]): void {
        const message = toPackets(PACKET.RESPONSE, Buffer.concat(tokens));
        (this.tlsSocket ?? this.socket).write(message);
    }

    private onMessage(type: number, payload: Buffer): void {
        switch (type) {
            case PACKET.PRELOGIN:
                if (this.tlsState === "handshake") this.tlsTransport!.push(payload);
                else this.onPrelogin(payload);
                break;
            case PACKET.LOGIN7:
                this.onLogin(payload);
                break;
            case PACKET.NTLM_AUTH:
                this.onNtlmAuthenticate(payload);
                break;
            case PACKET.FEDAUTH_TOKEN:
                // Total length, token length, then the token itself.
                this.onToken(payload.toString("ucs2", 8, 8 + payload.readUInt32LE(4)));
                break;
            case PACKET.SQL_BATCH:
                this.onRequest(afterHeaders(payload).toString("ucs2"), false);
                break;
            case PACKET.RPC:
                this.onRequest(rpcStatement(payload), true);
                break;
            case PACKET.ATTENTION:
                this.send(doneToken(TOKEN.DONE, DONE_ATTENTION));
                break;
            default:
                this.socket.destroy();
        }
    }

    private onPrelogin(payload: Buffer): void {
        const clientWantsFedAuth = parsePrelogin(payload).has(PRELOGIN_OPTION.FEDAUTH_REQUIRED);
        // Inside TDS 8.0 the connection is already encrypted: there is nothing left to negotiate.
        const useTls = !this.strict && this.server.encryption === "on";
        const options: [number, Buffer][] = [
            [PRELOGIN_OPTION.VERSION, Buffer.from([12, 0, 0x07, 0xd0, 0, 0])],
            [PRELOGIN_OPTION.ENCRYPTION, uint8(useTls ? ENCRYPT_ON : ENCRYPT_NOT_SUPPORTED)],
            [PRELOGIN_OPTION.INSTANCE, uint8(0)],
            [PRELOGIN_OPTION.THREAD_ID, Buffer.alloc(0)],
            [PRELOGIN_OPTION.MARS, uint8(0)],
        ];
        if (clientWantsFedAuth) options.push([PRELOGIN_OPTION.FEDAUTH_REQUIRED, uint8(1)]);
        this.send(buildPrelogin(options));
        if (useTls) this.startTls("handshake");
    }

    private onLogin(payload: Buffer): void {
        const login = parseLogin(payload, this.tlsSocket !== undefined, this.strict);
        this.login = login;
        this.server.logins.push(login);
        if (login.fedAuth?.library === "MSAL") {
            this.send(fedAuthInfoToken(this.server.stsUrl, this.server.spn));
        } else if (login.ntlm) {
            // Fixed challenge: the tests compute the expected response from it.
            login.ntlm.serverChallenge = Buffer.from("0123456789abcdef", "hex");
            const info = targetInfo(login.ntlm.negotiate.domain, this.server.identity.serverName);
            const challenge = challengeMessage(
                login.ntlm.serverChallenge,
                login.ntlm.negotiate.domain,
                info,
            );
            this.send(
                Buffer.concat([uint8(TOKEN.SSPI), uint16(challenge.length), challenge]),
                doneToken(TOKEN.DONE, DONE_MORE),
            );
        } else if (login.token !== undefined) {
            this.onToken(login.token);
        } else if (
            login.hasPassword &&
            this.server.sqlLogins.get(login.userName) === login.password
        ) {
            this.accept(login);
        } else {
            this.refuse(`Login failed for user '${login.userName}'.`);
        }
    }

    private onNtlmAuthenticate(payload: Buffer): void {
        const login = this.login;
        if (!login?.ntlm) {
            this.socket.destroy();
            return;
        }
        const authenticate = parseAuthenticate(payload);
        login.ntlm.authenticate = authenticate;
        const account = authenticate.domain
            ? `${authenticate.domain}\\${authenticate.userName}`
            : authenticate.userName;
        const password = [...this.server.windowsLogins].find(
            ([name]) => name.toUpperCase() === account.toUpperCase(),
        )?.[1];
        login.ntlm.proofValid =
            password !== undefined &&
            ntlmV2Proof(
                password,
                authenticate.userName,
                authenticate.domain,
                login.ntlm.serverChallenge,
                authenticate.temp,
            ).equals(authenticate.ntProof);
        if (login.ntlm.proofValid) this.accept(login);
        else this.refuse(`Login failed for user '${account}'.`);
    }

    private onToken(token: string): void {
        const login = this.login!;
        login.token = token;
        const refusal = this.server.rejectToken(token, login);
        if (refusal !== undefined) this.refuse(refusal);
        else this.accept(login);
    }

    private accept(login: FakeTdsLogin): void {
        const refusal = this.server.refuseLogin(login);
        if (refusal !== undefined) {
            this.refuse(refusal);
            return;
        }
        if (this.server.transientFailures > 0) {
            this.server.transientFailures--;
            const NOT_CURRENTLY_AVAILABLE = 40613;
            this.refuse(
                `Database '${login.database || "master"}' on server '${this.server.identity.serverName}' is not currently available.`,
                NOT_CURRENTLY_AVAILABLE,
            );
            return;
        }
        login.accepted = true;
        const tdsVersion = Buffer.alloc(4);
        tdsVersion.writeUInt32BE(login.tdsVersion === "8.0" ? 0x08000000 : 0x74000004);
        const sqlInterface = uint8(1);
        const DATABASE = 1;
        const ROUTING = 20;
        const route = this.server.redirectTo;
        // Routing value: protocol (0 = TCP), port, server name; then an empty old value.
        const routing =
            route && Buffer.concat([uint8(0), uint16(route.port), longText(route.host)]);
        this.send(
            routing
                ? sizedToken(
                      TOKEN.ENV_CHANGE,
                      uint8(ROUTING),
                      uint16(routing.length),
                      routing,
                      uint16(0),
                  )
                : sizedToken(
                      TOKEN.ENV_CHANGE,
                      uint8(DATABASE),
                      shortText(login.database || "master"),
                      shortText("master"),
                  ),
            sizedToken(
                TOKEN.LOGIN_ACK,
                sqlInterface,
                tdsVersion,
                shortText("Microsoft SQL Server"),
                Buffer.from([12, 0, 0x07, 0xd0]),
            ),
            // Acknowledges the FEDAUTH feature, with no data for the MSAL workflow.
            login.fedAuth
                ? Buffer.concat([
                      uint8(TOKEN.FEATURE_EXT_ACK),
                      uint8(FEATURE_FEDAUTH),
                      uint32(0),
                      uint8(0xff),
                  ])
                : Buffer.alloc(0),
            doneToken(TOKEN.DONE, DONE_FINAL),
        );
    }

    private refuse(message: string, number = 18456 /* login failed */): void {
        this.send(
            errorToken(number, message, this.server.identity.serverName),
            doneToken(TOKEN.DONE, DONE_ERROR),
        );
        (this.tlsSocket ?? this.socket).end();
    }

    private onRequest(sql: string, isRpc: boolean): void {
        const login = this.login;
        if (!login?.accepted) {
            this.socket.destroy();
            return;
        }
        login.requests.push(sql);
        const answer = this.server.answer(sql, login) ?? this.server.defaultAnswer(sql, login);
        if (answer && "error" in answer) {
            const error = errorToken(answer.number, answer.error, this.server.identity.serverName);
            this.send(
                error,
                doneToken(isRpc ? TOKEN.DONE_PROC : TOKEN.DONE, DONE_ERROR | DONE_FINAL),
            );
            return;
        }
        const result = answer;
        const tokens = result
            ? [
                  resultSetTokens(result),
                  doneToken(
                      isRpc ? TOKEN.DONE_IN_PROC : TOKEN.DONE,
                      DONE_COUNT,
                      result.rows.length,
                  ),
              ]
            : [];
        if (isRpc)
            tokens.push(
                Buffer.concat([uint8(TOKEN.RETURN_STATUS), uint32(0)]),
                doneToken(TOKEN.DONE_PROC, DONE_FINAL),
            );
        else if (!result) tokens.push(doneToken(TOKEN.DONE, DONE_FINAL));
        this.send(...tokens);
    }
}

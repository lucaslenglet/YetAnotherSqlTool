import { createHmac } from "node:crypto";

// NTLM (MS-NLMP) pieces for the fake TDS server and its tests. They are written from the
// specification, not taken from tedious, so that a test comparing them with what tedious sends
// proves something. Node's `crypto` has no MD4 (OpenSSL 3), hence the implementation below.

/** MD4 (RFC 1320). */
export function md4(input: Buffer): Buffer {
    const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
    const padded = Buffer.alloc((((input.length + 8) >> 6) + 1) * 64);
    input.copy(padded);
    padded[input.length] = 0x80;
    padded.writeUInt32LE((input.length * 8) >>> 0, padded.length - 8);
    padded.writeUInt32LE(Math.floor((input.length * 8) / 2 ** 32), padded.length - 4);

    let [A, B, C, D] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
    const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
    const H = (x: number, y: number, z: number) => x ^ y ^ z;
    const round2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const round3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];

    for (let offset = 0; offset < padded.length; offset += 64) {
        const X = Array.from({ length: 16 }, (_, i) => padded.readUInt32LE(offset + i * 4));
        let [a, b, c, d] = [A, B, C, D];
        const step = (
            fn: (x: number, y: number, z: number) => number,
            k: number,
            constant: number,
            s: number,
        ) => {
            const next = rotl((a + fn(b, c, d) + X[k] + constant) >>> 0, s);
            [a, b, c, d] = [d, next, b, c];
        };
        for (let i = 0; i < 16; i++) step(F, i, 0, [3, 7, 11, 19][i % 4]);
        for (let i = 0; i < 16; i++) step(G, round2[i], 0x5a827999, [3, 5, 9, 13][i % 4]);
        for (let i = 0; i < 16; i++) step(H, round3[i], 0x6ed9eba1, [3, 9, 11, 15][i % 4]);
        A = (A + a) >>> 0;
        B = (B + b) >>> 0;
        C = (C + c) >>> 0;
        D = (D + d) >>> 0;
    }
    const out = Buffer.alloc(16);
    [A, B, C, D].forEach((word, i) => out.writeUInt32LE(word, i * 4));
    return out;
}

const hmacMd5 = (key: Buffer, data: Buffer) => createHmac("md5", key).update(data).digest();

/** NTOWFv2 (MS-NLMP 3.3.2): HMAC_MD5(MD4(UNICODE(password)), UNICODE(UPPER(user) + domain)). */
export function ntowfV2(password: string, user: string, domain: string): Buffer {
    return hmacMd5(
        md4(Buffer.from(password, "ucs2")),
        Buffer.from(user.toUpperCase() + domain, "ucs2"),
    );
}

/** NTProofStr: HMAC_MD5(NTOWFv2, ServerChallenge + temp), the first 16 bytes of the NTLMv2 response. */
export function ntlmV2Proof(
    password: string,
    user: string,
    domain: string,
    serverChallenge: Buffer,
    temp: Buffer,
): Buffer {
    return hmacMd5(ntowfV2(password, user, domain), Buffer.concat([serverChallenge, temp]));
}

const MSV_AV = { EOL: 0, NB_COMPUTER_NAME: 1, NB_DOMAIN_NAME: 2 };

/** AV_PAIR list the server puts in its challenge (target information). */
export function targetInfo(domain: string, computer: string): Buffer {
    const pair = (id: number, value: string) => {
        const data = Buffer.from(value, "ucs2");
        const header = Buffer.alloc(4);
        header.writeUInt16LE(id, 0);
        header.writeUInt16LE(data.length, 2);
        return Buffer.concat([header, data]);
    };
    return Buffer.concat([
        pair(MSV_AV.NB_DOMAIN_NAME, domain),
        pair(MSV_AV.NB_COMPUTER_NAME, computer),
        pair(MSV_AV.EOL, ""),
    ]);
}

/**
 * CHALLENGE_MESSAGE (type 2) in the layout tedious reads: 56 bytes of header, then the target
 * name, then the target information.
 */
export function challengeMessage(serverChallenge: Buffer, domain: string, info: Buffer): Buffer {
    const name = Buffer.from(domain, "ucs2");
    const header = Buffer.alloc(56);
    header.write("NTLMSSP\0", 0, "ascii");
    header.writeUInt32LE(2, 8);
    header.writeUInt16LE(name.length, 12);
    header.writeUInt16LE(name.length, 14);
    header.writeUInt32LE(56, 16);
    // UNICODE, REQUEST_TARGET, NTLM, TARGET_TYPE_DOMAIN, EXTENDED_SESSIONSECURITY, TARGET_INFO, 128, 56
    header.writeUInt32LE(0xe2898205 >>> 0, 20);
    serverChallenge.copy(header, 24);
    header.writeUInt16LE(info.length, 40);
    header.writeUInt16LE(info.length, 42);
    header.writeUInt32LE(56 + name.length, 44);
    return Buffer.concat([header, name, info]);
}

export interface NtlmNegotiate {
    flags: number;
    /** Domain, in the OEM (ASCII) character set. */
    domain: string;
    workstation: string;
}

export function parseNegotiate(message: Buffer): NtlmNegotiate {
    if (message.toString("ascii", 0, 8) !== "NTLMSSP\0" || message.readUInt32LE(8) !== 1)
        throw new Error("Not an NTLM NEGOTIATE_MESSAGE");
    const field = (at: number) =>
        message.toString(
            "ascii",
            message.readUInt32LE(at + 4),
            message.readUInt32LE(at + 4) + message.readUInt16LE(at),
        );
    return { flags: message.readUInt32LE(12), domain: field(16), workstation: field(24) };
}

export interface NtlmAuthenticate {
    domain: string;
    userName: string;
    workstation: string;
    lmResponse: Buffer;
    /** The 16 bytes the message declares as the NTLMv2 response: NTProofStr. */
    ntProof: Buffer;
    /**
     * The "temp" structure (response version, timestamp, client challenge, target information...)
     * that follows the proof. tedious writes it right after the 16 declared bytes instead of
     * counting it in the field's length, so it is the rest of the message.
     */
    temp: Buffer;
    flags: number;
}

export function parseAuthenticate(message: Buffer): NtlmAuthenticate {
    if (message.toString("ascii", 0, 8) !== "NTLMSSP\0" || message.readUInt32LE(8) !== 3)
        throw new Error("Not an NTLM AUTHENTICATE_MESSAGE");
    const slice = (at: number) =>
        message.subarray(
            message.readUInt32LE(at + 4),
            message.readUInt32LE(at + 4) + message.readUInt16LE(at),
        );
    const ntOffset = message.readUInt32LE(20 + 4);
    return {
        lmResponse: slice(12),
        ntProof: slice(20),
        temp: message.subarray(ntOffset + message.readUInt16LE(20)),
        domain: slice(28).toString("ucs2"),
        userName: slice(36).toString("ucs2"),
        workstation: slice(44).toString("ucs2"),
        flags: message.readUInt32LE(60),
    };
}

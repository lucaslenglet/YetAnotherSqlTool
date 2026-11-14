import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A self-signed TLS certificate made on the fly, for the local servers the tests start. Node can
// read certificates but not create them, and a private key written in the repository would be
// flagged as a leaked secret: this builds the few DER structures of an X.509 certificate by hand.

export interface SelfSignedCertificate {
    /** Certificate, PEM. Also its own certificate authority. */
    cert: string;
    /** Private key, PEM (PKCS #8). */
    key: string;
}

function der(tag: number, ...content: Buffer[]): Buffer {
    const body = Buffer.concat(content);
    if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const significant = length.subarray(length.findIndex((byte) => byte !== 0));
    return Buffer.concat([Buffer.from([tag, 0x80 | significant.length]), significant, body]);
}

const sequence = (...content: Buffer[]) => der(0x30, ...content);
const oid = (...bytes: number[]) => der(0x06, Buffer.from(bytes));
/** "YYMMDDHHMMSSZ" */
const utcTime = (date: Date) =>
    der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

const ECDSA_WITH_SHA256 = sequence(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);

/** A certificate for `localhost` and 127.0.0.1, valid from yesterday for a month. */
export function createSelfSignedCertificate(commonName = "localhost"): SelfSignedCertificate {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const day = 24 * 60 * 60 * 1000;

    const name = sequence(der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from(commonName)))));
    const alternativeNames = sequence(
        der(0x82, Buffer.from("localhost")), // dNSName
        der(0x87, Buffer.from([127, 0, 0, 1])), // iPAddress
    );
    const toBeSigned = sequence(
        der(0xa0, der(0x02, Buffer.from([2]))), // version 3
        der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])), // serial number, positive
        ECDSA_WITH_SHA256,
        name, // issuer
        sequence(utcTime(new Date(Date.now() - day)), utcTime(new Date(Date.now() + 30 * day))),
        name, // subject
        publicKey.export({ type: "spki", format: "der" }),
        der(0xa3, sequence(sequence(SUBJECT_ALT_NAME, der(0x04, alternativeNames)))),
    );
    const signature = sign("sha256", toBeSigned, privateKey);
    const certificate = sequence(
        toBeSigned,
        ECDSA_WITH_SHA256,
        der(0x03, Buffer.from([0]), signature),
    );

    const base64Lines = certificate
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n");
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${base64Lines}\n-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    };
}

/**
 * tedious (the TDS client under `mssql`) converts some values into JS types that lose information:
 *   - decimal / numeric / money become a JS number (precision loss beyond ~15 digits),
 *   - datetimeoffset becomes a Date (the offset is dropped).
 * SSMS shows those values exactly, so we wrap tedious' internal value reader to keep what is lost:
 *   - decimal / numeric / money / smallmoney are returned as exact decimal STRINGS ("1234.50"),
 *   - datetimeoffset Dates get a non-enumerable `offsetMinutes` property.
 * The wrapper calls the original reader first (so reading position and null handling stay correct)
 * and only re-decodes the bytes it just consumed.
 *
 * This relies on tedious internals (lib/value-parser): tedious is pinned to an exact version in package.json,
 * and test/drivers/mssql/cellFormats.test.ts fails if an upgrade breaks this wrapper.
 */

interface ParsedValue {
    value: unknown;
    offset: number;
}

interface ColumnMetadataLike {
    type: { name: string };
    scale?: number;
}

type ReadValue = (
    buf: Buffer,
    offset: number,
    metadata: ColumnMetadataLike,
    options: unknown,
) => ParsedValue;

let installed = false;

export function installRawValueReaders(): void {
    if (installed) return;
    installed = true;

    // tedious calls `valueParser.readValue(...)` through its exports object, so replacing the property works.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const valueParser = require("tedious/lib/value-parser") as { readValue: ReadValue };
    const originalReadValue = valueParser.readValue;

    valueParser.readValue = (buf, offset, metadata, options) => {
        const result = originalReadValue(buf, offset, metadata, options);
        if (result.value === null || result.value === undefined) return result;

        switch (metadata.type.name) {
            case "NumericN":
            case "DecimalN":
                // Layout: [length byte] then the sign and magnitude.
                result.value = decodeDecimal(buf, offset + 1, buf[offset], metadata.scale ?? 0);
                break;
            case "Variant":
                result.value = decodeVariantDecimal(buf, offset, result) ?? result.value;
                break;
            case "MoneyN":
                result.value = decodeMoney(buf, offset + 1, buf[offset]);
                break;
            case "Money":
                result.value = decodeMoney(buf, offset, 8);
                break;
            case "SmallMoney":
                result.value = decodeMoney(buf, offset, 4);
                break;
            case "DateTimeOffset":
                // The last two bytes of a datetimeoffset value are the offset in minutes.
                Object.defineProperty(result.value as Date, "offsetMinutes", {
                    enumerable: false,
                    value: buf.readInt16LE(result.offset - 2),
                });
                break;
        }
        return result;
    };
}

/** Layout: [sign byte: 1 = positive][magnitude, little endian]; `byteLength` counts both. */
function decodeDecimal(buf: Buffer, start: number, byteLength: number, scale: number): string {
    const isNegative = buf[start] === 0;
    const magnitude = readLittleEndianBigInt(buf, start + 1, byteLength - 1);
    return unitsToDecimalString(isNegative ? -magnitude : magnitude, scale);
}

/**
 * sql_variant layout: [uint32 length][base type][property byte count][properties][data].
 * For decimal (0x6A) and numeric (0x6C) the properties are precision and scale. Returns undefined for other types.
 */
function decodeVariantDecimal(buf: Buffer, start: number, result: ParsedValue): string | undefined {
    const baseTypeOffset = start + 4;
    const baseType = buf[baseTypeOffset];
    if (baseType !== 0x6a && baseType !== 0x6c) return undefined;
    const propertyByteCount = buf[baseTypeOffset + 1];
    const scale = buf[baseTypeOffset + 3];
    const dataStart = baseTypeOffset + 2 + propertyByteCount;
    return decodeDecimal(buf, dataStart, result.offset - dataStart, scale);
}

/** money is an int64 holding ten-thousandths; smallmoney is an int32 with the same unit. */
function decodeMoney(buf: Buffer, start: number, byteLength: number): string {
    let units: bigint;
    if (byteLength === 4) {
        units = BigInt(buf.readInt32LE(start));
    } else {
        // tedious stores money as high int32 first, then low uint32.
        units = (BigInt(buf.readInt32LE(start)) << 32n) + BigInt(buf.readUInt32LE(start + 4));
    }
    return unitsToDecimalString(units, 4);
}

function readLittleEndianBigInt(buf: Buffer, start: number, byteLength: number): bigint {
    let value = 0n;
    for (let i = byteLength - 1; i >= 0; i--) {
        value = (value << 8n) | BigInt(buf[start + i]);
    }
    return value;
}

/** 123450n with scale 2 -> "1234.50". */
function unitsToDecimalString(units: bigint, scale: number): string {
    const isNegative = units < 0n;
    const digits = (isNegative ? -units : units).toString().padStart(scale + 1, "0");
    const integerPart = digits.slice(0, digits.length - scale);
    const fractionPart = digits.slice(digits.length - scale);
    return (isNegative ? "-" : "") + integerPart + (scale > 0 ? "." + fractionPart : "");
}

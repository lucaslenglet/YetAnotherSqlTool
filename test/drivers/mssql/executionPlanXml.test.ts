import { describe, expect, it } from "vitest";
import {
    formatDateTimeShort,
    formatDouble,
    formatFixed,
    roundHalfEven,
    xmlConvertDouble,
    ClrDateTime,
} from "../../../src/drivers/mssql/executionPlan/clr";
import { parseXml } from "../../../src/drivers/mssql/executionPlan/xml";

describe("the showplan XML reader", () => {
    it("reads elements, attributes, namespaces and text", () => {
        const root = parseXml(
            '<?xml version="1.0" encoding="utf-16"?>\n<!-- a plan -->\n<a xmlns="urn:x" xmlns:p="urn:p" one="1" p:two=\'2\'>\n  <b>text<?pi data?> more</b><p:c/><d><![CDATA[<raw> & ]]></d></a>\n',
        );
        expect(root).toMatchObject({ name: "a", localName: "a", namespace: "urn:x" });
        expect(root.attributes.map((a) => [a.name, a.localName, a.namespace, a.value])).toEqual([
            ["xmlns", "xmlns", "http://www.w3.org/2000/xmlns/", "urn:x"],
            ["xmlns:p", "p", "http://www.w3.org/2000/xmlns/", "urn:p"],
            ["one", "one", "", "1"],
            ["p:two", "two", "urn:p", "2"],
        ]);
        expect(root.children.map((c) => [c.name, c.namespace, c.text])).toEqual([
            ["b", "urn:x", "text more"],
            ["p:c", "urn:p", ""],
            ["d", "urn:x", "<raw> & "],
        ]);
        expect(root.children[0].parent).toBe(root);
    });

    it("decodes entities and character references", () => {
        const root = parseXml(
            '<a v="&lt;&gt;&amp;&quot;&apos;&#233;&#x1F600;">&lt;x&gt; &#xD;&#xA;</a>',
        );
        expect(root.attributes[0].value).toBe("<>&\"'é😀");
        expect(root.text).toBe("<x> \r\n");
    });

    it("normalizes attribute values as XML 1.0 does: literal breaks become spaces, references stay", () => {
        const root = parseXml('<a v="one\r\ntwo\tthree&#xD;&#xA;four"/>');
        expect(root.attributes[0].value).toBe("one two three\r\nfour");
        // Text keeps line breaks, CR LF read as LF.
        expect(parseXml("<a>x\r\ny\rz</a>").text).toBe("x\ny\nz");
    });

    it("skips a byte order mark", () => {
        expect(parseXml("\uFEFF<a/>").name).toBe("a");
    });

    it.each([
        ["", /no root element/],
        ["<a>", /missing end tag <\/a>/],
        ["<a></b>", /unexpected end tag <\/b>/],
        ["<a/><b/>", /content after the root element/],
        ["text<a/>", /text outside the root element/],
        ['<a x="1" x="2"/>', /duplicate attribute x/],
        ['<a x="1"y="2"/>', /space expected/],
        ["<a x=1/>", /quoted attribute value expected/],
        ["<a>&nbsp;</a>", /unknown entity &nbsp;/],
        ["<a>&#0;</a>", /invalid character reference/],
        ["<a>&#12abc;</a>", /invalid character reference/],
        ["<a>&constructor;</a>", /unknown entity &constructor;/],
        [
            '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>',
            /document type declarations are not supported/,
        ],
        ["<p:a/>", /undeclared namespace prefix 'p'/],
        ["<a><!-- open</a>", /unterminated comment/],
    ])("refuses %j", (text, error) => {
        expect(() => parseXml(text)).toThrow(error);
    });

    it("gives the line and column of an error", () => {
        expect(() => parseXml("<a>\n  <b></c>\n</a>")).toThrow(/line 2, column 10/);
    });
});

describe(".NET number and date formatting", () => {
    it.each([
        [0, "0"],
        [1, "1"],
        [-2.5, "-2.5"],
        [0.0032831, "0.0032831"],
        [0.0001, "0.0001"],
        [0.00001, "1E-05"],
        [1.5e-7, "1.5E-07"],
        [123456789012345, "123456789012345"],
        [1e15, "1E+15"],
        [1234567890123456, "1.234567890123456E+15"],
        [0.30000000000000004, "0.30000000000000004"],
        [Infinity, "∞"],
        [NaN, "NaN"],
    ])("double.ToString(): %d -> %s", (value, text) => {
        expect(formatDouble(value)).toBe(text);
    });

    it("XmlConvert.ToString(double)", () => {
        expect(xmlConvertDouble(49.3232)).toBe("49.3232");
        expect(xmlConvertDouble(Infinity)).toBe("INF");
        expect(xmlConvertDouble(-Infinity)).toBe("-INF");
    });

    it.each([
        [0, 7, "0"],
        [0.0032831, 7, "0.0032831"],
        [0.00000042, 7, "0.0000004"],
        [0.00000005, 7, "0.0000001"],
        [0.00000004, 7, "0"],
        [2613.3200000000002, 7, "2613.32"],
        [1e20, 7, "100000000000000000000"],
        [16.995, 2, "17"],
        [16.994, 2, "16.99"],
        [0.5, 0, "1"],
        [9.999, 2, "10"],
        [-1.005, 2, "-1.01"],
    ])('ToString("0.###"): %d with %d decimals -> %s', (value, decimals, text) => {
        expect(formatFixed(value, decimals)).toBe(text);
    });

    it("Math.Round rounds ties to even", () => {
        expect([0.5, 1.5, 2.5, -1.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, -2, 2, 3]);
    });

    it("DateTimeConverter (en-US on Linux): short date, and short time unless midnight", () => {
        expect(formatDateTimeShort(new ClrDateTime(2026, 11, 7, 18, 5, 59, 5000000))).toBe(
            "11/7/2026 6:05\u202FPM",
        );
        expect(formatDateTimeShort(new ClrDateTime(2026, 1, 2, 0, 30, 0, 0))).toBe(
            "1/2/2026 12:30\u202FAM",
        );
        expect(formatDateTimeShort(new ClrDateTime(2026, 1, 2, 0, 0, 0, 0))).toBe("1/2/2026");
    });
});

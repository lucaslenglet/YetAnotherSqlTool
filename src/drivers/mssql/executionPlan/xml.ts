/**
 * A small, strict XML reader for showplan documents. The extension host has no DOMParser, and the
 * XML libraries already bundled do not decode entities, so this reads what a showplan uses:
 * elements, attributes, namespaces, text, CDATA, comments, processing instructions, the predefined
 * entities and character references. Attribute values are normalized as XML 1.0 requires (a literal
 * tab or line break becomes a space, a character reference stays), which is what .NET's reader
 * gives sqltoolsservice: "&#xD;&#xA;" in StatementText is a real line break, a literal one is not.
 * A document type declaration is refused (showplans have none, and it could declare entities).
 */

export interface XmlAttribute {
    /** Qualified name as written ("Name", "xsi:type"). */
    name: string;
    localName: string;
    namespace: string;
    value: string;
}

export interface XmlElement {
    /** Qualified name as written. */
    name: string;
    localName: string;
    namespace: string;
    attributes: XmlAttribute[];
    children: XmlElement[];
    /** Concatenated character data directly inside the element. */
    text: string;
    parent?: XmlElement;
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const NAME = /[A-Za-z_:À-￿][\w.\-:·À-￿]*/y;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Parses `text` and returns its root element. Throws an Error with a position on malformed XML. */
export function parseXml(text: string): XmlElement {
    // XML 1.0 end-of-line handling: CR LF and lone CR become LF before anything else.
    const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    let pos = 0;
    let root: XmlElement | undefined;
    const stack: { element: XmlElement; namespaces: Map<string, string> }[] = [];

    const fail = (message: string): never => {
        const before = source.slice(0, pos);
        const line = before.split("\n").length;
        const column = pos - before.lastIndexOf("\n");
        throw new Error(`Invalid XML (line ${line}, column ${column}): ${message}`);
    };
    const readName = (): string => {
        NAME.lastIndex = pos;
        const m = NAME.exec(source);
        if (!m) fail("name expected");
        pos += m![0].length;
        return m![0];
    };
    const skipSpaces = () => {
        while (pos < source.length && " \t\n".includes(source[pos])) pos++;
    };
    const decode = (raw: string, attribute: boolean): string => {
        let out = "";
        let i = 0;
        while (i < raw.length) {
            const c = raw[i];
            if (c === "&") {
                const end = raw.indexOf(";", i);
                if (end < 0) fail("unterminated entity reference");
                const entity = raw.slice(i + 1, end);
                if (/^#x[0-9A-Fa-f]+$/.test(entity))
                    out += codePoint(parseInt(entity.slice(2), 16), entity);
                else if (/^#[0-9]+$/.test(entity))
                    out += codePoint(parseInt(entity.slice(1), 10), entity);
                else if (entity.startsWith("#")) fail(`invalid character reference &${entity};`);
                else if (Object.prototype.hasOwnProperty.call(PREDEFINED, entity))
                    out += PREDEFINED[entity];
                else fail(`unknown entity &${entity};`);
                i = end + 1;
            } else if (c === "<" && attribute) {
                fail("'<' in an attribute value");
            } else {
                out += attribute && (c === "\t" || c === "\n") ? " " : c;
                i++;
            }
        }
        return out;
    };
    const codePoint = (value: number, entity: string): string => {
        if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff)
            fail(`invalid character reference &${entity};`);
        return String.fromCodePoint(value);
    };
    const resolve = (
        prefix: string,
        namespaces: Map<string, string>,
        isAttribute: boolean,
    ): string => {
        if (prefix === "xml") return XML_NAMESPACE;
        if (prefix === "xmlns") return XMLNS_NAMESPACE;
        if (prefix === "" && isAttribute) return "";
        const uri = namespaces.get(prefix);
        if (uri === undefined) {
            if (prefix === "") return "";
            fail(`undeclared namespace prefix '${prefix}'`);
        }
        return uri!;
    };
    const split = (qualified: string): [string, string] => {
        const colon = qualified.indexOf(":");
        return colon < 0
            ? ["", qualified]
            : [qualified.slice(0, colon), qualified.slice(colon + 1)];
    };

    while (pos < source.length) {
        const lt = source.indexOf("<", pos);
        if (lt < 0) {
            appendText(source.slice(pos));
            pos = source.length;
            break;
        }
        if (lt > pos) appendText(source.slice(pos, lt));
        pos = lt;
        if (source.startsWith("<!--", pos)) {
            const end = source.indexOf("-->", pos + 4);
            if (end < 0) fail("unterminated comment");
            pos = end + 3;
        } else if (source.startsWith("<![CDATA[", pos)) {
            const end = source.indexOf("]]>", pos + 9);
            if (end < 0) fail("unterminated CDATA section");
            if (!stack.length) fail("character data outside the root element");
            stack[stack.length - 1].element.text += source.slice(pos + 9, end);
            pos = end + 3;
        } else if (source.startsWith("<?", pos)) {
            const end = source.indexOf("?>", pos + 2);
            if (end < 0) fail("unterminated processing instruction");
            pos = end + 2;
        } else if (source.startsWith("<!", pos)) {
            fail("document type declarations are not supported");
        } else if (source.startsWith("</", pos)) {
            pos += 2;
            const name = readName();
            skipSpaces();
            if (source[pos] !== ">") fail("'>' expected");
            pos++;
            const open = stack.pop();
            if (!open || open.element.name !== name) fail(`unexpected end tag </${name}>`);
        } else {
            pos++;
            const name = readName();
            const raw: [string, string][] = [];
            for (;;) {
                const hadSpace = pos < source.length && " \t\n".includes(source[pos]);
                skipSpaces();
                if (source[pos] === ">" || source.startsWith("/>", pos)) break;
                if (!hadSpace) fail("space expected between attributes");
                const attrName = readName();
                skipSpaces();
                if (source[pos] !== "=") fail("'=' expected");
                pos++;
                skipSpaces();
                const quote = source[pos];
                if (quote !== '"' && quote !== "'") fail("quoted attribute value expected");
                const end = source.indexOf(quote, pos + 1);
                if (end < 0) fail("unterminated attribute value");
                const value = decode(source.slice(pos + 1, end), true);
                if (raw.some(([n]) => n === attrName)) fail(`duplicate attribute ${attrName}`);
                raw.push([attrName, value]);
                pos = end + 1;
            }
            const selfClosing = source[pos] === "/";
            pos += selfClosing ? 2 : 1;
            if (root && !stack.length) fail("content after the root element");

            const namespaces = new Map(stack.length ? stack[stack.length - 1].namespaces : []);
            for (const [attrName, value] of raw) {
                if (attrName === "xmlns") namespaces.set("", value);
                else if (attrName.startsWith("xmlns:")) namespaces.set(attrName.slice(6), value);
            }
            const [prefix, localName] = split(name);
            const element: XmlElement = {
                name,
                localName,
                namespace: resolve(prefix, namespaces, false),
                attributes: raw.map(([attrName, value]) => {
                    const [attrPrefix, attrLocal] = split(attrName);
                    const namespace =
                        attrName === "xmlns"
                            ? XMLNS_NAMESPACE
                            : resolve(attrPrefix, namespaces, true);
                    return { name: attrName, localName: attrLocal, namespace, value };
                }),
                children: [],
                text: "",
            };
            if (stack.length) {
                const parent = stack[stack.length - 1].element;
                element.parent = parent;
                parent.children.push(element);
            } else {
                root = element;
            }
            if (!selfClosing) stack.push({ element, namespaces });
        }
    }
    if (stack.length) fail(`missing end tag </${stack[stack.length - 1].element.name}>`);
    if (!root) fail("no root element");
    return root!;

    function appendText(raw: string) {
        if (!stack.length) {
            if (raw.trim()) fail("text outside the root element");
            return;
        }
        stack[stack.length - 1].element.text += decode(raw, false);
    }
}

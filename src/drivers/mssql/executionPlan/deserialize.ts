/**
 * Reads a showplan document into the object model of showplanxml.cs, as .NET's XmlSerializer does
 * for sqltoolsservice: same classes, same values for absent attributes, same "...Specified" flags,
 * unknown elements and attributes ignored, an unknown enum value an error.
 */

import {
    ClrArray,
    ClrDateTime,
    ClrEnum,
    ClrNumber,
    ClrXmlAttribute,
    ClrXmlElement,
    type NumericType,
    SchemaObject,
} from "./clr";
import type { SchemaClass, SchemaMember } from "./schemaTypes";
import { SHOWPLAN_CLASSES, SHOWPLAN_ENUMS } from "./showplanSchema.generated";
import type { XmlElement } from "./xml";

export const SHOWPLAN_NAMESPACE = "http://schemas.microsoft.com/sqlserver/2004/07/showplan";

/** A member of a class, with the class that declares it (reflection order: derived class first). */
export interface ReflectedMember extends SchemaMember {
    declaringClass: string;
}

const membersCache = new Map<string, ReflectedMember[]>();

/** Public properties of a class in the order .NET reflection returns them: its own, then its base's. */
export function reflectedMembers(className: string): ReflectedMember[] {
    let members = membersCache.get(className);
    if (!members) {
        members = [];
        for (let name: string | undefined = className; name; name = schemaClass(name).base) {
            members.push(
                ...schemaClass(name).members.map((m) => ({ ...m, declaringClass: name! })),
            );
        }
        membersCache.set(className, members);
    }
    return members;
}

/** Members in the order XmlSerializer reads and writes them: base class first. */
export function serializationMembers(className: string): SchemaMember[] {
    const chain: SchemaClass[] = [];
    for (let name: string | undefined = className; name; name = schemaClass(name).base) {
        chain.unshift(schemaClass(name));
    }
    return chain.flatMap((c) => c.members);
}

export function schemaClass(name: string): SchemaClass {
    const cls = SHOWPLAN_CLASSES[name];
    if (!cls) throw new Error(`Unknown showplan type ${name}`);
    return cls;
}

export function isSchemaClass(type: string): boolean {
    return type in SHOWPLAN_CLASSES;
}

export function isEnum(type: string): boolean {
    return type in SHOWPLAN_ENUMS;
}

/** XML value of an enum member (what XmlSerializer writes). */
export function enumXmlValue(enumType: string, member: string): string {
    const entry = SHOWPLAN_ENUMS[enumType]?.find(([name]) => name === member);
    return entry ? (entry[1] ?? entry[0]) : member;
}

/** Reads the root ShowPlanXML element. */
export function deserializeShowPlan(root: XmlElement): SchemaObject {
    if (root.localName !== "ShowPlanXML" || root.namespace !== SHOWPLAN_NAMESPACE) {
        throw new Error(
            `There is an error in XML document (<${root.name} xmlns='${root.namespace}'> was not expected).`,
        );
    }
    return readObject(root, "ShowPlanXML");
}

function readObject(element: XmlElement, className: string): SchemaObject {
    const values = new Map<string, unknown>();
    const members = serializationMembers(className);

    for (const member of members) {
        if (member.attribute !== undefined) {
            const attribute = element.attributes.find(
                (a) => a.localName === member.attribute && a.namespace === "",
            );
            if (attribute) {
                values.set(member.name, readPrimitive(attribute.value, member.type));
                if (members.some((m) => m.name === member.name + "Specified")) {
                    values.set(member.name + "Specified", true);
                }
            } else {
                values.set(member.name, defaultValue(member.type));
            }
        } else if (member.anyAttribute) {
            // Every attribute no member maps, namespace declarations aside.
            const any = element.attributes.filter(
                (a) =>
                    a.name !== "xmlns" &&
                    !a.name.startsWith("xmlns:") &&
                    !(a.namespace === "" && members.some((m) => m.attribute === a.localName)),
            );
            values.set(
                member.name,
                any.length
                    ? new ClrArray(
                          "System.Xml.XmlAttribute",
                          any.map((a) => new ClrXmlAttribute(a)),
                      )
                    : null,
            );
        }
    }

    const children = element.children.filter((c) => c.namespace === SHOWPLAN_NAMESPACE);
    const elementMembers = members.filter((m) => m.elements || m.array);
    const ordered = elementMembers.some((m) => m.order !== undefined);
    const consumed = new Set<XmlElement>();

    if (ordered) {
        // Members with an Order are read in sequence: an element goes to the first member, from the
        // current one on, that accepts its name (DefinedValue: Item then Items both take ColumnReference).
        // An element no remaining member accepts is skipped, as XmlSerializer skips unknown nodes.
        let index = 0;
        for (const child of children) {
            let next = index;
            while (next < elementMembers.length && !accepts(elementMembers[next], child.localName))
                next++;
            if (next >= elementMembers.length) continue;
            index = next;
            const member = elementMembers[index];
            assign(values, member, child, members);
            consumed.add(child);
            if (!member.type.endsWith("[]")) index++;
        }
    } else {
        for (const child of children) {
            const member = elementMembers.find((m) => accepts(m, child.localName));
            if (!member) continue;
            assign(values, member, child, members);
            consumed.add(child);
        }
    }
    for (const member of members) {
        if (member.anyElement) {
            const any = element.children.filter((c) => !consumed.has(c));
            values.set(
                member.name,
                any.length
                    ? new ClrArray(
                          "System.Xml.XmlElement",
                          any.map((c) => new ClrXmlElement(c)),
                      )
                    : null,
            );
        }
    }
    // Members never seen are null (reference types) or their default (value types).
    for (const member of members) {
        if (!values.has(member.name)) values.set(member.name, defaultValue(member.type));
    }
    return new SchemaObject(className, values, element.localName);
}

function accepts(member: SchemaMember, name: string): boolean {
    if (member.array !== undefined) return member.array === name;
    return member.elements!.some(([elementName]) => elementName === name);
}

function assign(
    values: Map<string, unknown>,
    member: SchemaMember,
    child: XmlElement,
    members: SchemaMember[],
) {
    if (member.array !== undefined) {
        values.set(member.name, readArray(child, member));
        return;
    }
    const [, choiceType] = member.elements!.find(([name]) => name === child.localName)!;
    const isArray = member.type.endsWith("[]");
    const declared = isArray ? member.type.slice(0, -2) : member.type;
    const type = choiceType ?? declared;
    const value = isSchemaClass(type) ? readObject(child, type) : readPrimitive(child.text, type);
    if (member.choice) {
        // The identifier property's type names the enum (ItemsChoiceType[] / ItemChoiceType).
        const identifier = members.find((m) => m.name === member.choice);
        const enumType = identifier ? identifier.type.replace(/\[\]$/, "") : "object";
        const choice = new ClrEnum(enumType, child.localName);
        if (isArray) {
            const items = (values.get(member.choice) as ClrArray | undefined)?.items ?? [];
            values.set(member.choice, new ClrArray(enumType, [...items, choice]));
        } else {
            values.set(member.choice, choice);
        }
    }
    if (isArray) {
        const previous = values.get(member.name) as ClrArray | undefined;
        values.set(member.name, new ClrArray(declared, [...(previous?.items ?? []), value]));
    } else {
        values.set(member.name, value);
    }
}

function readArray(wrapper: XmlElement, member: SchemaMember): ClrArray {
    const elementType = member.type.slice(0, -2);
    const items = wrapper.children.filter(
        (c) => c.namespace === SHOWPLAN_NAMESPACE && c.localName === member.arrayItem,
    );
    if (member.arrayItemNested !== undefined) {
        // Jagged array (ScalarType[][]): <Values><Row><ScalarOperator/>…</Row></Values>.
        const innerType = elementType.slice(0, -2);
        return new ClrArray(
            elementType,
            items.map(
                (row) =>
                    new ClrArray(
                        innerType,
                        row.children
                            .filter(
                                (c) =>
                                    c.namespace === SHOWPLAN_NAMESPACE &&
                                    c.localName === member.arrayItemNested,
                            )
                            .map((c) => readObject(c, innerType)),
                    ),
            ),
        );
    }
    return new ClrArray(
        elementType,
        items.map((c) =>
            isSchemaClass(elementType)
                ? readObject(c, elementType)
                : readPrimitive(c.text, elementType),
        ),
    );
}

const NUMERIC: Record<string, NumericType> = { int: "int", ulong: "ulong", double: "double" };

function readPrimitive(text: string, type: string): unknown {
    const trimmed = text.trim();
    if (type === "string") return text;
    if (type === "bool") {
        if (trimmed === "true" || trimmed === "1") return true;
        if (trimmed === "false" || trimmed === "0") return false;
        throw invalid(text, type);
    }
    if (type in NUMERIC) {
        const numeric = NUMERIC[type];
        if (numeric === "double") {
            if (trimmed === "INF") return new ClrNumber("double", Infinity);
            if (trimmed === "-INF") return new ClrNumber("double", -Infinity);
            if (trimmed === "NaN") return new ClrNumber("double", NaN);
            if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) throw invalid(text, type);
            return new ClrNumber("double", Number(trimmed));
        }
        if (!/^[+-]?\d+$/.test(trimmed)) throw invalid(text, type);
        const value = Number(trimmed);
        if (numeric === "ulong" && value < 0) throw invalid(text, type);
        return new ClrNumber(numeric, value);
    }
    if (type === "System.DateTime") {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(trimmed);
        if (!m) throw invalid(text, type);
        const ticks = m[7] ? Number(m[7].padEnd(7, "0").slice(0, 7)) : 0;
        return new ClrDateTime(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], ticks);
    }
    if (isEnum(type)) {
        const entry = SHOWPLAN_ENUMS[type].find(([name, xml]) => (xml ?? name) === text);
        if (!entry)
            throw new Error(
                `There is an error in XML document: instance validation error: '${text}' is not a valid value for ${type}.`,
            );
        return new ClrEnum(type, entry[0]);
    }
    throw new Error(`Unsupported showplan type ${type}`);
}

function invalid(text: string, type: string): Error {
    return new Error(`There is an error in XML document: '${text}' is not a valid ${type} value.`);
}

/** default(T): null for reference types, 0 / false / the first member for value types. */
export function defaultValue(type: string): unknown {
    if (type.endsWith("[]")) return null;
    if (type === "bool") return false;
    if (type in NUMERIC) return new ClrNumber(NUMERIC[type], 0);
    if (type === "System.DateTime") return new ClrDateTime(1, 1, 1, 0, 0, 0, 0);
    if (isEnum(type)) return new ClrEnum(type, SHOWPLAN_ENUMS[type][0][0]);
    return null;
}

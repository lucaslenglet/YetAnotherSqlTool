import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildConnectionString,
    parseConnectionString,
} from "../../../src/drivers/mssql/connectionString";

const reference = JSON.parse(
    readFileSync(
        resolve(__dirname, "../../../docs/reference/mssql-connection-strings.json"),
        "utf8",
    ),
);

describe("mssql parseConnectionString", () => {
    it("understands server, database, user and password synonyms", () => {
        for (const server of [
            "Server",
            "Data Source",
            "Address",
            "Addr",
            "Network Address",
            "data source",
        ]) {
            expect(parseConnectionString(`${server}=h`).server).toBe("h");
        }
        for (const database of ["Database", "Initial Catalog"])
            expect(parseConnectionString(`Server=h;${database}=d`).database).toBe("d");
        for (const user of ["User ID", "UID", "User", "userid"])
            expect(parseConnectionString(`Server=h;${user}=u`).user).toBe("u");
        for (const password of ["Password", "PWD"])
            expect(parseConnectionString(`Server=h;${password}=p`).password).toBe("p");
    });

    it("maps Encrypt values to the option values", () => {
        const encrypt = (value: string) =>
            parseConnectionString(`Server=h;Encrypt=${value}`).encrypt;
        expect(["true", "Yes", "Mandatory"].map(encrypt)).toEqual([
            "Mandatory",
            "Mandatory",
            "Mandatory",
        ]);
        expect(["False", "no", "optional"].map(encrypt)).toEqual([
            "Optional",
            "Optional",
            "Optional",
        ]);
        expect(encrypt("strict")).toBe("Strict");
        expect(() => encrypt("maybe")).toThrow(/Encrypt/);
    });

    it("parses the other documented keywords", () => {
        const options = parseConnectionString(
            "Server=h;TrustServerCertificate=yes;Connection Timeout=5;Command Timeout=7;App=zz;WSID=ws;Packet Size=4096;" +
                "Language=us_english;Application Intent=ReadOnly;MultiSubnetFailover=true;Host Name In Certificate=hh",
        );
        expect(options).toMatchObject({
            server: "h",
            trustServerCertificate: true,
            connectTimeout: 5,
            commandTimeout: 7,
            applicationName: "zz",
            workstationId: "ws",
            packetSize: 4096,
            currentLanguage: "us_english",
            applicationIntent: "ReadOnly",
            multiSubnetFailover: true,
            hostNameInCertificate: "hh",
        });
        expect(
            parseConnectionString("Server=h;Trust Server Certificate=false").trustServerCertificate,
        ).toBe(false);
        expect(parseConnectionString("Server=h;Timeout=9").connectTimeout).toBe(9);
    });

    it("maps authentication", () => {
        const auth = (text: string) => parseConnectionString(`Server=h;${text}`).authenticationType;
        expect(auth("User=u")).toBe("SqlLogin");
        expect(auth("Authentication=SqlPassword")).toBe("SqlLogin");
        expect(auth("Authentication=Active Directory Interactive")).toBe("AzureMFA");
        expect(auth("Authentication=Active Directory Default")).toBe("ActiveDirectoryDefault");
        expect(auth("Integrated Security=true")).toBe("Integrated");
        expect(auth("Trusted_Connection=SSPI")).toBe("Integrated");
        expect(auth("Integrated Security=false")).toBe("SqlLogin");
        expect(auth("Integrated Security=SSPI")).toBe("Integrated");
        expect(auth("Trusted Connection=yes")).toBe("Integrated");
        expect(() => auth("Authentication=Nope")).toThrow(/Authentication/);
    });

    it("keeps User ID and Password next to Integrated Security (the NTLM account)", () => {
        expect(
            parseConnectionString(
                "Server=h;Integrated Security=SSPI;User ID=CORP\\alice;Password=pw",
            ),
        ).toEqual({
            server: "h",
            authenticationType: "Integrated",
            user: "CORP\\alice",
            password: "pw",
        });
    });

    it("handles quoting and escaping", () => {
        expect(parseConnectionString("Server=h;Password='a;b'").password).toBe("a;b");
        expect(parseConnectionString('Server=h;Password="a""b"').password).toBe('a"b');
        expect(parseConnectionString("Server=h;Password='it''s'").password).toBe("it's");
        expect(parseConnectionString('Server=h;Password= "a b" ;User=u')).toMatchObject({
            password: "a b",
            user: "u",
        });
        expect(parseConnectionString("Server = h ; Database = d ;").database).toBe("d");
        expect(parseConnectionString("Server=h;;;Database=d").database).toBe("d");
        expect(parseConnectionString("Server=h;Password=a=b").password).toBe("a=b");
    });

    it("keeps server text such as host,port and host\\instance", () => {
        expect(parseConnectionString("Server=tcp:h,1444").server).toBe("tcp:h,1444");
        expect(parseConnectionString("Server=h\\inst").server).toBe("h\\inst");
    });

    it("ignores unknown keys and empty values", () => {
        expect(parseConnectionString("Server=h;Bogus=1;Database=")).toEqual({
            server: "h",
            authenticationType: "SqlLogin",
        });
    });

    it("throws readable errors for malformed input", () => {
        expect(() => parseConnectionString("Server=h;Database")).toThrow(/expected "="/);
        expect(() => parseConnectionString("Server=h;=x")).toThrow(/key is missing/);
        expect(() => parseConnectionString("Server=h;Password='abc")).toThrow(/not closed/);
        expect(() => parseConnectionString("Server=h;Password='a'b")).toThrow(/unexpected text/);
        expect(() => parseConnectionString("Server=h;Connect Timeout=abc")).toThrow(/integer/);
        expect(() => parseConnectionString("Server=h;TrustServerCertificate=maybe")).toThrow(
            /boolean/,
        );
        expect(() => parseConnectionString("Server=tcp:myhost,1444;Password=p;w;d;")).toThrow();
    });

    it.each(reference.parse.filter((c: any) => !c.error && c.options))(
        "agrees with sqltoolsservice on $input",
        (c: any) => {
            const parsed = parseConnectionString(c.input);
            expect(parsed.server).toBe(c.options.server);
            expect(parsed.database).toBe(c.options.database ?? undefined);
            expect(parsed.authenticationType).toBe(c.options.authenticationType);
            if (c.options.user) expect(parsed.user).toBe(c.options.user);
            if (c.options.password) expect(parsed.password).toBe(c.options.password);
            if (c.options.hostNameInCertificate)
                expect(parsed.hostNameInCertificate).toBe(c.options.hostNameInCertificate);
            if (c.options.packetSize) expect(parsed.packetSize).toBe(c.options.packetSize);
        },
    );

    it.each(reference.parse.filter((c: any) => c.error && !/Bogus/.test(c.input)))(
        "rejects what sqltoolsservice rejects: $input",
        (c: any) => {
            expect(() => parseConnectionString(c.input)).toThrow();
        },
    );
});

describe("mssql buildConnectionString", () => {
    const full = {
        server: "h,1433",
        database: "d",
        authenticationType: "SqlLogin",
        user: "u",
        password: "p;q",
        encrypt: "Mandatory",
        trustServerCertificate: true,
        applicationName: "a b",
        connectTimeout: 30,
        commandTimeout: 30,
        applicationIntent: "ReadOnly",
        multiSubnetFailover: true,
        packetSize: 4096,
        workstationId: "w",
        currentLanguage: "us_english",
        hostNameInCertificate: "hh",
    };

    it("emits the sqltoolsservice spelling and order, without the password unless asked", () => {
        const withPassword = buildConnectionString(full, true);
        expect(withPassword).toBe(
            'Data Source=h,1433;Initial Catalog=d;User ID=u;Password="p;q";Connect Timeout=30;Encrypt=True;Host Name In Certificate=hh;' +
                'Trust Server Certificate=True;Packet Size=4096;Authentication=SqlPassword;Application Name="a b";Current Language=us_english;' +
                "Workstation ID=w;Application Intent=ReadOnly;Multi Subnet Failover=True;Command Timeout=30",
        );
        expect(buildConnectionString(full, false)).not.toContain(";Password=");
    });

    it("matches the reference output apart from Pooling and the masked password", () => {
        for (const c of reference.build.filter(
            (b: any) => b.includePassword && b.options.authenticationType === "SqlLogin",
        )) {
            expect(buildConnectionString(c.options, true)).toBe(
                c.result.replace("Pooling=False;", ""),
            );
        }
    });

    it("quotes values with quotes and joins the port option to the server", () => {
        const text = buildConnectionString(
            {
                server: "h",
                port: 1500,
                user: "u",
                password: 'it\'s "x"',
                authenticationType: "SqlLogin",
            },
            true,
        );
        expect(text).toBe(
            'Data Source=h,1500;User ID=u;Password="it\'s ""x""";Authentication=SqlPassword',
        );
    });

    it("writes Integrated Security with the Windows account, and Entra ID authentication", () => {
        // An ADO.NET client would ignore the user and the password; ours signs in with them (NTLM).
        expect(
            buildConnectionString(
                {
                    server: "h",
                    user: "CORP\\alice",
                    password: "pw",
                    authenticationType: "Integrated",
                },
                true,
            ),
        ).toBe("Data Source=h;Integrated Security=True;User ID=CORP\\alice;Password=pw");
        expect(
            buildConnectionString(
                {
                    server: "h",
                    user: "CORP\\alice",
                    password: "pw",
                    authenticationType: "Integrated",
                },
                false,
            ),
        ).toBe("Data Source=h;Integrated Security=True;User ID=CORP\\alice");
        expect(buildConnectionString({ server: "h", authenticationType: "Integrated" }, true)).toBe(
            "Data Source=h;Integrated Security=True",
        );
        expect(
            buildConnectionString(
                { server: "h", user: "a@b.c", authenticationType: "AzureMFA", encrypt: "Strict" },
                false,
            ),
        ).toBe(
            'Data Source=h;User ID=a@b.c;Encrypt=Strict;Authentication="Active Directory Interactive"',
        );
    });

    it("skips unset options", () => {
        expect(
            buildConnectionString({ server: "h", database: "", packetSize: undefined }, true),
        ).toBe("Data Source=h");
    });
});

describe("mssql connection string round trip", () => {
    it("parse(build(x)) equals x", () => {
        const samples = [
            {
                server: "h\\inst",
                database: "my db",
                authenticationType: "SqlLogin",
                user: "u;x",
                password: 'it\'s "x" = ;',
                encrypt: "Strict",
                trustServerCertificate: false,
                applicationName: " spaced ",
                connectTimeout: 15,
                commandTimeout: 0,
                applicationIntent: "ReadWrite",
                multiSubnetFailover: false,
                packetSize: 8192,
                workstationId: "w",
                currentLanguage: "français",
                hostNameInCertificate: "x.example.com",
            },
            { server: "h", authenticationType: "AzureMFA", user: "a@b.c", encrypt: "Optional" },
            { server: "h", authenticationType: "Integrated" },
            { server: "h", authenticationType: "Integrated", user: "CORP\\alice", password: "p;w" },
            { server: "h", authenticationType: "Integrated", user: "alice@corp.example.com" },
        ];
        for (const sample of samples)
            expect(parseConnectionString(buildConnectionString(sample, true))).toEqual(sample);
    });
});

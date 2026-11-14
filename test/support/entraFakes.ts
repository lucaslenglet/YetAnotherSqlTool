import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

// Local stand-ins for the Microsoft side of Entra ID sign-ins: access tokens, the token endpoint
// of a managed identity and the service principal credential. Nothing here talks to Microsoft.

const base64url = (value: object | Buffer) =>
    (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString("base64url");

/**
 * A JWT shaped like an Entra ID access token (same header, claims and length), with random bytes
 * in place of the signature. Azure would refuse it; the local servers only compare its bytes.
 * `lifetimeSeconds` may be negative for a token that has already expired.
 */
export function forgeAccessToken(
    claims: Record<string, unknown> = {},
    lifetimeSeconds = 3600,
): string {
    const now = Math.floor(Date.now() / 1000);
    const tenant = "11111111-1111-4111-8111-111111111111";
    const header = { typ: "JWT", alg: "RS256", x5t: "forged-locally", kid: "forged-locally" };
    const payload = {
        aud: "https://database.windows.net/",
        iss: `https://sts.windows.net/${tenant}/`,
        iat: now - 300,
        nbf: now - 300,
        exp: now + lifetimeSeconds,
        appid: "22222222-2222-4222-8222-222222222222",
        oid: "33333333-3333-4333-8333-333333333333",
        tid: tenant,
        scp: "user_impersonation",
        ver: "1.0",
        // Real tokens carry many more claims and take 1,500 to 2,500 characters. The size matters:
        // such a token does not fit in one 4 KB packet of SQL Server's protocol.
        acr: "1",
        aio: randomBytes(60).toString("base64url"),
        amr: ["pwd", "mfa"],
        groups: Array.from(
            { length: 20 },
            (_, index) => `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
        rh: randomBytes(40).toString("base64url"),
        uti: randomBytes(16).toString("base64url"),
        ...claims,
    };
    return [base64url(header), base64url(payload), base64url(randomBytes(256))].join(".");
}

/** `exp` claim of a forged token, in milliseconds. */
export function expiresOn(token: string): number {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp * 1000;
}

export interface ManagedIdentityRequest {
    /** Audience asked for, e.g. "https://database.windows.net". */
    resource: string;
    /** Client ID of a user-assigned managed identity, when one was asked for. */
    clientId?: string;
}

export interface ManagedIdentityEndpoint {
    /** Token requests received, in order. Tests empty it between cases. */
    readonly requests: ManagedIdentityRequest[];
    /** Returns the token to hand out; tests replace it. */
    issue: (request: ManagedIdentityRequest) => string;
    stop(): Promise<void>;
}

/**
 * Starts the token endpoint of a managed identity on 127.0.0.1, speaking the protocol Azure App
 * Service offers to the code it hosts, and points this process to it (IDENTITY_ENDPOINT and
 * IDENTITY_HEADER). The real DefaultAzureCredential then finds a managed identity, with no fake
 * inside @azure/identity: its own HTTP request arrives here.
 *
 * Start it once per test file (beforeAll): the library remembers the first endpoint it finds
 * for as long as the process lives.
 */
export async function startManagedIdentityEndpoint(): Promise<ManagedIdentityEndpoint> {
    const secret = randomBytes(16).toString("hex");
    const requests: ManagedIdentityRequest[] = [];
    const endpoint: ManagedIdentityEndpoint = { requests, issue: () => forgeAccessToken(), stop };
    const server: Server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.headers["x-identity-header"] !== secret || !url.searchParams.get("resource")) {
            response.writeHead(400).end();
            return;
        }
        const received = {
            resource: url.searchParams.get("resource")!,
            clientId: url.searchParams.get("client_id") ?? undefined,
        };
        requests.push(received);
        const token = endpoint.issue(received);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                access_token: token,
                expires_on: String(Math.floor(expiresOn(token) / 1000)),
                resource: received.resource,
                token_type: "Bearer",
                client_id: received.clientId ?? "44444444-4444-4444-8444-444444444444",
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    // What comes before a managed identity in the DefaultAzureCredential chain, and the other
    // kinds of managed identity, must not be found on the machine running the tests.
    for (const name of [
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_CLIENT_CERTIFICATE_PATH",
        "AZURE_USERNAME",
        "AZURE_PASSWORD",
        "AZURE_FEDERATED_TOKEN_FILE",
        "AZURE_TOKEN_CREDENTIALS",
        "IDENTITY_SERVER_THUMBPRINT",
        "IMDS_ENDPOINT",
        "MSI_ENDPOINT",
        "MSI_SECRET",
    ]) {
        vi.stubEnv(name, undefined);
    }
    vi.stubEnv(
        "IDENTITY_ENDPOINT",
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/msi/token`,
    );
    vi.stubEnv("IDENTITY_HEADER", secret);

    async function stop(): Promise<void> {
        vi.unstubAllEnvs();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return endpoint;
}

/**
 * Takes the place of @azure/identity's ClientSecretCredential, whose token request can only go
 * to Microsoft's sign-in service. Use it with:
 *
 *     vi.mock("@azure/identity", async (importOriginal) => {
 *         const { FakeClientSecretCredential } = await import("<path>/support/entraFakes");
 *         return { ...(await importOriginal<object>()), ClientSecretCredential: FakeClientSecretCredential };
 *     });
 */
export class FakeClientSecretCredential {
    /** Every credential the code under test created, in order. */
    static readonly created: FakeClientSecretCredential[] = [];
    /** Returns the token of a service principal; tests replace it. */
    static issue: (credential: FakeClientSecretCredential, scope: string) => string = () =>
        forgeAccessToken();

    /** Scopes asked to this credential, one entry per token request. */
    readonly scopes: string[] = [];

    constructor(
        readonly tenantId: string,
        readonly clientId: string,
        readonly clientSecret: string,
    ) {
        FakeClientSecretCredential.created.push(this);
    }

    async getToken(scopes: string | string[]) {
        const scope = [scopes].flat().join(" ");
        this.scopes.push(scope);
        const token = FakeClientSecretCredential.issue(this, scope);
        return { token, expiresOnTimestamp: expiresOn(token) };
    }

    static reset(): void {
        FakeClientSecretCredential.created.length = 0;
        FakeClientSecretCredential.issue = () => forgeAccessToken();
    }
}

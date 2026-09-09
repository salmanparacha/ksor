/**
 * The Bedrock credential resolver: container workload-role endpoint, static
 * environment variables, then AgentCore MMDSv2 / EC2 IMDSv2. Temporary
 * credentials are cached until shortly before expiry. A resolution failure is
 * a typed `BedrockCredentialsError`, which the providers classify as fatal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultCredentialProvider } from "./bedrock-env.js";
import { BedrockCredentialsError, isFatal } from "./bedrock-rest.js";

const KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Unit tests never contact a link-local metadata address by
  // accident. Tests exercising MMDS opt in explicitly below.
  process.env["AWS_EC2_METADATA_DISABLED"] = "true";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function jsonFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("static environment credentials", () => {
  it("returns access key + secret, and the session token when present", async () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
    process.env["AWS_SESSION_TOKEN"] = "sess";
    const creds = await defaultCredentialProvider()();
    expect(creds).toEqual({ accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "sess" });
  });

  it("omits the session token for long-lived keys", async () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
    expect(await defaultCredentialProvider()()).toEqual({
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
  });

  it("throws a typed BedrockCredentialsError when nothing is configured", async () => {
    await expect(defaultCredentialProvider()()).rejects.toBeInstanceOf(BedrockCredentialsError);
  });
});

describe("AgentCore / ECS workload-role endpoint", () => {
  it("fetches temporary credentials, forwards the authorization token, and returns the session token", async () => {
    process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"] = "http://169.254.170.23/v1/creds";
    process.env["AWS_CONTAINER_AUTHORIZATION_TOKEN"] = "tok-abc";
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { impl, calls } = jsonFetch({
      AccessKeyId: "ASIA",
      SecretAccessKey: "wrk-secret",
      Token: "wrk-session",
      Expiration: future,
    });
    const creds = await defaultCredentialProvider({ fetchImpl: impl })();
    expect(creds).toEqual({
      accessKeyId: "ASIA",
      secretAccessKey: "wrk-secret",
      sessionToken: "wrk-session",
    });
    expect(calls[0]!.url).toBe("http://169.254.170.23/v1/creds");
    expect(calls[0]!.headers["authorization"]).toBe("tok-abc");
  });

  it("builds the relative URI against the ECS metadata host", async () => {
    process.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"] = "/v2/credentials/abc";
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { impl, calls } = jsonFetch({
      AccessKeyId: "ASIA",
      SecretAccessKey: "s",
      Token: "t",
      Expiration: future,
    });
    await defaultCredentialProvider({ fetchImpl: impl })();
    expect(calls[0]!.url).toBe("http://169.254.170.2/v2/credentials/abc");
  });

  it("caches until the refresh margin, then refreshes when the credentials near expiry", async () => {
    process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"] = "http://169.254.170.23/v1/creds";
    let clock = 0;
    // Expires 10 minutes out; refresh margin is 5 minutes.
    const { impl, calls } = jsonFetch({
      AccessKeyId: "ASIA",
      SecretAccessKey: "s",
      Token: "t",
      Expiration: new Date(10 * 60 * 1000).toISOString(),
    });
    const provider = defaultCredentialProvider({ fetchImpl: impl, now: () => clock });
    await provider(); // fetch #1
    clock = 4 * 60 * 1000; // still inside the cache window (< expiry - margin = 5 min)
    await provider(); // served from cache
    expect(calls.length, "no refetch inside the cache window").toBe(1);
    clock = 6 * 60 * 1000; // past expiry - margin
    await provider(); // fetch #2
    expect(calls.length, "refetched near expiry").toBe(2);
  });

  it("throws BedrockCredentialsError when the endpoint refuses (403)", async () => {
    process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"] = "http://169.254.170.23/v1/creds";
    const { impl } = jsonFetch({ message: "Forbidden" }, 403);
    await expect(defaultCredentialProvider({ fetchImpl: impl })()).rejects.toBeInstanceOf(
      BedrockCredentialsError,
    );
  });

  it("throws BedrockCredentialsError when the response omits the keys", async () => {
    process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"] = "http://169.254.170.23/v1/creds";
    const { impl } = jsonFetch({ Token: "t" });
    await expect(defaultCredentialProvider({ fetchImpl: impl })()).rejects.toBeInstanceOf(
      BedrockCredentialsError,
    );
  });
});

describe("AgentCore MMDSv2 execution-role credentials", () => {
  it("obtains an MMDSv2 token, discovers the role, and returns its temporary credentials", async () => {
    delete process.env["AWS_EC2_METADATA_DISABLED"];
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, method: init?.method ?? "GET", headers });
      if (url.endsWith("/latest/api/token")) return new Response("mmds-token");
      if (url.endsWith("/latest/meta-data/iam/security-credentials/")) {
        return new Response("healthlake-runtime-role\n");
      }
      return new Response(
        JSON.stringify({
          Code: "Success",
          AccessKeyId: "ASIA",
          SecretAccessKey: "mmds-secret",
          Token: "mmds-session",
          Expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
    }) as typeof fetch;

    const creds = await defaultCredentialProvider({ fetchImpl: impl })();

    expect(creds).toEqual({
      accessKeyId: "ASIA",
      secretAccessKey: "mmds-secret",
      sessionToken: "mmds-session",
    });
    expect(calls).toEqual([
      {
        url: "http://169.254.169.254/latest/api/token",
        method: "PUT",
        headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
      },
      {
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        method: "GET",
        headers: { "x-aws-ec2-metadata-token": "mmds-token" },
      },
      {
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/healthlake-runtime-role",
        method: "GET",
        headers: { "x-aws-ec2-metadata-token": "mmds-token" },
      },
    ]);
  });

  it("honors the standard metadata endpoint override", async () => {
    delete process.env["AWS_EC2_METADATA_DISABLED"];
    process.env["AWS_EC2_METADATA_SERVICE_ENDPOINT"] = "http://[fd00:ec2::254]";
    const urls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/latest/api/token")) return new Response("token");
      if (url.endsWith("/latest/meta-data/iam/security-credentials/")) {
        return new Response("role");
      }
      return new Response(
        JSON.stringify({
          AccessKeyId: "ASIA",
          SecretAccessKey: "secret",
          Token: "session",
          Expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
    }) as typeof fetch;

    await defaultCredentialProvider({ fetchImpl: impl })();

    expect(urls[0]).toBe("http://[fd00:ec2::254]/latest/api/token");
  });

  it("caches MMDS credentials until the refresh margin, then runs the full exchange again", async () => {
    delete process.env["AWS_EC2_METADATA_DISABLED"];
    let clock = 0;
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/latest/api/token")) return new Response("token");
      if (url.endsWith("/latest/meta-data/iam/security-credentials/")) {
        return new Response("role");
      }
      return new Response(
        JSON.stringify({
          AccessKeyId: "ASIA",
          SecretAccessKey: "secret",
          Token: "session",
          Expiration: new Date(10 * 60 * 1000).toISOString(),
        }),
      );
    }) as typeof fetch;
    const provider = defaultCredentialProvider({ fetchImpl: impl, now: () => clock });

    await provider();
    clock = 4 * 60 * 1000;
    await provider();
    expect(calls).toHaveLength(3);
    clock = 6 * 60 * 1000;
    await provider();
    expect(calls).toHaveLength(6);
  });

  it("classifies malformed MMDS credential JSON as a fatal credential failure", async () => {
    delete process.env["AWS_EC2_METADATA_DISABLED"];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/latest/api/token")) return new Response("token");
      if (url.endsWith("/latest/meta-data/iam/security-credentials/")) {
        return new Response("role");
      }
      return new Response("SENTINEL-CREDENTIAL-MATERIAL-not-json");
    }) as typeof fetch;

    const rejection = await defaultCredentialProvider({ fetchImpl: impl })().catch(
      (exc: unknown) => exc,
    );

    expect(rejection).toBeInstanceOf(BedrockCredentialsError);
    expect(isFatal(rejection)).toBe(true);
    expect(String(rejection)).not.toContain("SENTINEL-C");
  });

  it.each([
    {
      name: "session token",
      response: {
        AccessKeyId: "ASIA",
        SecretAccessKey: "secret",
        Expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    },
    {
      name: "usable expiration",
      response: {
        AccessKeyId: "ASIA",
        SecretAccessKey: "secret",
        Token: "session",
        Expiration: "not-an-instant",
      },
    },
  ])("rejects an MMDS response without a $name", async ({ response }) => {
    delete process.env["AWS_EC2_METADATA_DISABLED"];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/latest/api/token")) return new Response("token");
      if (url.endsWith("/latest/meta-data/iam/security-credentials/")) {
        return new Response("role");
      }
      return new Response(JSON.stringify(response));
    }) as typeof fetch;

    const rejection = await defaultCredentialProvider({ fetchImpl: impl })().catch(
      (exc: unknown) => exc,
    );

    expect(rejection).toBeInstanceOf(BedrockCredentialsError);
    expect(isFatal(rejection)).toBe(true);
  });

  it("wraps an MMDS role-body read failure as a fatal credential failure", async () => {
    delete process.env["AWS_EC2_METADATA_DISABLED"];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/latest/api/token")) return new Response("token");
      return {
        ok: true,
        status: 200,
        text: async () => Promise.reject(new Error("body read failed")),
      } as Response;
    }) as typeof fetch;

    const rejection = await defaultCredentialProvider({ fetchImpl: impl })().catch(
      (exc: unknown) => exc,
    );

    expect(rejection).toBeInstanceOf(BedrockCredentialsError);
    expect(isFatal(rejection)).toBe(true);
  });
});

/**
 * The Bedrock credential resolver: static environment variables for local/dev,
 * and the AgentCore/ECS workload-role endpoint (fetched, then cached until just
 * before expiry so a long ingest refreshes mid-run) in a container. A
 * resolution failure is a typed `BedrockCredentialsError`, which the providers
 * classify as fatal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultCredentialProvider } from "./bedrock-env.js";
import { BedrockCredentialsError } from "./bedrock-rest.js";

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
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
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

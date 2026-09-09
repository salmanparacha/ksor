/**
 * The default AWS region + credential resolution for the keyless Bedrock
 * providers (Cohere and Titan) — model-neutral, dependency-free (`fetch` +
 * `node:fs`), and resolved at CALL time so rotating credentials are picked up
 * without rebuilding the provider.
 *
 * THREE credential sources, in priority order:
 *
 *   1. **Container workload-role endpoint.** When `AWS_CONTAINER_CREDENTIALS_FULL_URI` or
 *      `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is set, temporary credentials
 *      are FETCHED from it (with the authorization token from
 *      `AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]`), and CACHED until shortly
 *      before their `Expiration`. A long ingest therefore refreshes the role's
 *      short-lived credentials automatically, mid-run — env vars alone go stale
 *      and the drain would then fail 403 partway through (decision: the
 *      deployment runs under an AgentCore workload role, not static keys).
 *   2. **Static environment variables.** `AWS_ACCESS_KEY_ID` /
 *      `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`) — the local/dev shape,
 *      exactly what `aws configure export-credentials --format env` prints.
 *   3. **MMDSv2 / IMDSv2.** AgentCore Runtime provides its execution role via
 *      the MicroVM Metadata Service (MMDS), using the IMDSv2 token protocol.
 *      EC2 uses the same protocol. This source is skipped when
 *      `AWS_EC2_METADATA_DISABLED=true`.
 *
 * A resolution failure throws `BedrockCredentialsError`, which the providers
 * classify as FATAL: the ingest drain aborts with the queue pending rather than
 * quarantining chunks for an account problem.
 *
 * If a deployment needs the rest of the SDK credential chain (profiles, SSO
 * auto-refresh), it supplies its own `credentials` through the provider's
 * `clientFactory`/constructor — the seam takes it.
 */

import { readFileSync } from "node:fs";

import {
  BedrockCredentialsError,
  type AwsCredentials,
  type CredentialProvider,
} from "./bedrock-rest.js";

/** The region for Bedrock, from the standard AWS environment variables. Read at
 * provider-build time, so a missing region fails at boot (config), before any
 * ingest drain — not a per-call credential failure. */
export function defaultAwsRegion(): string {
  const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"] || "";
  if (region === "") {
    throw new Error(
      "bedrock: no AWS region — set AWS_REGION (or AWS_DEFAULT_REGION) to the region " +
        "your Bedrock model runs in (e.g. AWS_REGION=us-east-1)",
    );
  }
  return region;
}

/** Refresh this long before a workload-role credential's stated expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Cache window when the endpoint returns credentials with no `Expiration`. */
const NO_EXPIRY_TTL_MS = 5 * 60 * 1000;
const METADATA_TIMEOUT_MS = 1000;
const DEFAULT_METADATA_ENDPOINT = "http://169.254.169.254";
const MMDS_TOKEN_TTL_SECONDS = "21600";

/** The container credential endpoint, or null when none is configured. */
function containerEndpoint(): string | null {
  const full = process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
  if (full !== undefined && full !== "") return full;
  const relative = process.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  if (relative !== undefined && relative !== "") return "http://169.254.170.2" + relative;
  return null;
}

/** The authorization token for the container endpoint: a file (preferred, and
 * re-read each time so a rotated token is honored) or an inline variable. */
function containerToken(): string | undefined {
  const file =
    process.env["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"] ??
    process.env["AWS_CONTAINER_CREDENTIALS_TOKEN_FILE"];
  if (file !== undefined && file !== "") {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (exc) {
      throw new BedrockCredentialsError(
        `bedrock: could not read the workload-role token file ${JSON.stringify(file)}: ` +
          (exc instanceof Error ? exc.message : String(exc)),
      );
    }
  }
  const inline =
    process.env["AWS_CONTAINER_AUTHORIZATION_TOKEN"] ??
    process.env["AWS_CONTAINER_CREDENTIALS_TOKEN"];
  return inline !== undefined && inline !== "" ? inline : undefined;
}

function envCredentials(): AwsCredentials | null {
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"] || "";
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"] || "";
  if (accessKeyId === "" && secretAccessKey === "") return null;
  if (accessKeyId === "" || secretAccessKey === "") {
    throw new BedrockCredentialsError(
      "bedrock: incomplete static AWS credentials — AWS_ACCESS_KEY_ID and " +
        "AWS_SECRET_ACCESS_KEY must be set together",
    );
  }
  const sessionToken = process.env["AWS_SESSION_TOKEN"];
  return sessionToken !== undefined && sessionToken !== ""
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };
}

interface ContainerCredsResponse {
  readonly AccessKeyId?: string;
  readonly SecretAccessKey?: string;
  readonly Token?: string;
  readonly Expiration?: string;
}

function credentialsFromResponse(json: unknown, source: string): AwsCredentials {
  if (typeof json !== "object" || json === null) {
    throw new BedrockCredentialsError(`bedrock: ${source} returned a non-object response`);
  }
  const value = json as ContainerCredsResponse;
  if (
    typeof value.AccessKeyId !== "string" ||
    value.AccessKeyId === "" ||
    typeof value.SecretAccessKey !== "string" ||
    value.SecretAccessKey === ""
  ) {
    throw new BedrockCredentialsError(`bedrock: ${source} returned no AccessKeyId/SecretAccessKey`);
  }
  return typeof value.Token === "string" && value.Token !== ""
    ? {
        accessKeyId: value.AccessKeyId,
        secretAccessKey: value.SecretAccessKey,
        sessionToken: value.Token,
      }
    : { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey };
}

async function responseText(response: Response, source: string): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw new BedrockCredentialsError(`bedrock: could not read ${source}`);
  }
}

async function responseJson(response: Response, source: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // JSON parser errors can echo fragments of the response. Credential
    // responses contain secrets, so the wrapped error deliberately does not.
    throw new BedrockCredentialsError(`bedrock: could not decode ${source}`);
  }
}

/**
 * Resolve credentials at call time. Tries the container workload-role
 * endpoint, static variables, then MMDSv2/IMDSv2. Temporary credentials are
 * cached until just before expiry, so a long run refreshes automatically.
 * Test seams: `fetchImpl` and `now`.
 */
export function defaultCredentialProvider(opts?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): CredentialProvider {
  const doFetch = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? ((): number => Date.now());
  let cache: { creds: AwsCredentials; expiresAtMs: number } | null = null;

  return async (): Promise<AwsCredentials> => {
    const endpoint = containerEndpoint();
    if (endpoint === null) {
      const staticCredentials = envCredentials();
      if (staticCredentials !== null) return staticCredentials;
    }

    const isMmds = endpoint === null;
    if (isMmds && process.env["AWS_EC2_METADATA_DISABLED"]?.toLowerCase() === "true") {
      throw new BedrockCredentialsError(
        "bedrock: no AWS credentials — no container or static credentials were configured, " +
          "and AWS_EC2_METADATA_DISABLED=true prevents MMDS/IMDS resolution",
      );
    }

    // Serve from cache until the refresh margin before expiry.
    if (cache !== null && now() < cache.expiresAtMs - REFRESH_MARGIN_MS) return cache.creds;

    if (isMmds) {
      const base = (
        process.env["AWS_EC2_METADATA_SERVICE_ENDPOINT"] || DEFAULT_METADATA_ENDPOINT
      ).replace(/\/+$/, "");
      const signal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
      let tokenResponse: Response;
      try {
        tokenResponse = await doFetch(`${base}/latest/api/token`, {
          method: "PUT",
          headers: { "x-aws-ec2-metadata-token-ttl-seconds": MMDS_TOKEN_TTL_SECONDS },
          signal,
        });
      } catch (exc) {
        throw new BedrockCredentialsError(
          "bedrock: MMDSv2 token request failed: " +
            (exc instanceof Error ? exc.message : String(exc)),
        );
      }
      if (!tokenResponse.ok) {
        throw new BedrockCredentialsError(
          `bedrock: MMDSv2 token endpoint returned ${tokenResponse.status}`,
        );
      }
      const token = (await responseText(tokenResponse, "MMDSv2 token response")).trim();
      if (token === "")
        throw new BedrockCredentialsError("bedrock: MMDSv2 returned an empty token");
      const metadataHeaders = { "x-aws-ec2-metadata-token": token };

      let roleResponse: Response;
      try {
        roleResponse = await doFetch(`${base}/latest/meta-data/iam/security-credentials/`, {
          method: "GET",
          headers: metadataHeaders,
          signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
        });
      } catch (exc) {
        throw new BedrockCredentialsError(
          "bedrock: MMDSv2 role discovery failed: " +
            (exc instanceof Error ? exc.message : String(exc)),
        );
      }
      if (!roleResponse.ok) {
        throw new BedrockCredentialsError(
          `bedrock: MMDSv2 role discovery returned ${roleResponse.status}`,
        );
      }
      const role =
        (await responseText(roleResponse, "MMDSv2 role response")).trim().split(/\s+/u)[0] ?? "";
      if (role === "")
        throw new BedrockCredentialsError("bedrock: MMDSv2 returned no execution role");

      let credentialsResponse: Response;
      try {
        credentialsResponse = await doFetch(
          `${base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
          {
            method: "GET",
            headers: metadataHeaders,
            signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
          },
        );
      } catch (exc) {
        throw new BedrockCredentialsError(
          "bedrock: MMDSv2 credential request failed: " +
            (exc instanceof Error ? exc.message : String(exc)),
        );
      }
      if (!credentialsResponse.ok) {
        throw new BedrockCredentialsError(
          `bedrock: MMDSv2 credential endpoint returned ${credentialsResponse.status}`,
        );
      }
      const json = await responseJson(credentialsResponse, "MMDSv2 credential response");
      const creds = credentialsFromResponse(json, "MMDSv2 credential endpoint");
      const value = json as ContainerCredsResponse;
      if (typeof value.Token !== "string" || value.Token === "") {
        throw new BedrockCredentialsError(
          "bedrock: MMDSv2 credential endpoint returned no session token",
        );
      }
      const parsed = typeof value.Expiration === "string" ? Date.parse(value.Expiration) : NaN;
      if (!Number.isFinite(parsed) || parsed <= now()) {
        throw new BedrockCredentialsError(
          "bedrock: MMDSv2 credential endpoint returned no usable Expiration",
        );
      }
      cache = { creds, expiresAtMs: parsed };
      return creds;
    }

    const headers: Record<string, string> = {};
    const token = containerToken();
    if (token !== undefined) headers["authorization"] = token;

    let res: Response;
    try {
      res = await doFetch(endpoint, { headers });
    } catch (exc) {
      throw new BedrockCredentialsError(
        `bedrock: workload-role credential fetch to ${endpoint} failed: ` +
          (exc instanceof Error ? exc.message : String(exc)),
      );
    }
    if (!res.ok) {
      throw new BedrockCredentialsError(
        `bedrock: workload-role endpoint ${endpoint} returned ${res.status} — the task role's ` +
          "credential provider refused (check the container credentials token and the role).",
      );
    }
    const json = await responseJson(res, `workload-role endpoint ${endpoint} response`);
    const creds = credentialsFromResponse(json, `workload-role endpoint ${endpoint}`);
    const value = json as ContainerCredsResponse;
    const parsed = value.Expiration !== undefined ? Date.parse(value.Expiration) : NaN;
    const expiresAtMs = Number.isNaN(parsed) ? now() + NO_EXPIRY_TTL_MS : parsed;
    cache = { creds, expiresAtMs };
    return creds;
  };
}

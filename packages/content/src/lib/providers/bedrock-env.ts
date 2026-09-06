/**
 * The default AWS region + credential resolution for the keyless Bedrock
 * providers (Cohere and Titan) — model-neutral, dependency-free (`fetch` +
 * `node:fs`), and resolved at CALL time so rotating credentials are picked up
 * without rebuilding the provider.
 *
 * TWO credential sources, in priority order — the container/workload-role
 * endpoint FIRST, because that is how AgentCore Runtime, ECS and EKS hand a
 * task its role:
 *
 *   1. **Workload-role endpoint.** When `AWS_CONTAINER_CREDENTIALS_FULL_URI` or
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
 *
 * A resolution failure throws `BedrockCredentialsError`, which the providers
 * classify as FATAL: the ingest drain aborts with the queue pending rather than
 * quarantining chunks for an account problem.
 *
 * If a deployment needs the full SDK credential chain (profiles, SSO
 * auto-refresh, IMDS), it supplies its own `credentials` through the provider's
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

function envCredentials(): AwsCredentials {
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"] || "";
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"] || "";
  if (accessKeyId === "" || secretAccessKey === "") {
    throw new BedrockCredentialsError(
      "bedrock: no AWS credentials — set a workload-role endpoint " +
        "(AWS_CONTAINER_CREDENTIALS_FULL_URI / _RELATIVE_URI, as AgentCore/ECS provide) or export " +
        "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (plus AWS_SESSION_TOKEN for SSO/STS). " +
        "`aws configure export-credentials --profile <p> --format env` prints the static form.",
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

/**
 * Resolve credentials at call time. Prefers the workload-role endpoint (cached
 * until just before expiry, so a long run refreshes automatically); otherwise
 * the static environment variables. Test seams: `fetchImpl` and `now`.
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
    if (endpoint === null) return envCredentials();

    // Serve from cache until the refresh margin before expiry.
    if (cache !== null && now() < cache.expiresAtMs - REFRESH_MARGIN_MS) return cache.creds;

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
    const json = (await res.json()) as ContainerCredsResponse;
    if (!json.AccessKeyId || !json.SecretAccessKey) {
      throw new BedrockCredentialsError(
        `bedrock: workload-role endpoint ${endpoint} returned no AccessKeyId/SecretAccessKey`,
      );
    }
    const creds: AwsCredentials =
      json.Token !== undefined && json.Token !== ""
        ? {
            accessKeyId: json.AccessKeyId,
            secretAccessKey: json.SecretAccessKey,
            sessionToken: json.Token,
          }
        : { accessKeyId: json.AccessKeyId, secretAccessKey: json.SecretAccessKey };
    const parsed = json.Expiration !== undefined ? Date.parse(json.Expiration) : NaN;
    const expiresAtMs = Number.isNaN(parsed) ? now() + NO_EXPIRY_TTL_MS : parsed;
    cache = { creds, expiresAtMs };
    return creds;
  };
}

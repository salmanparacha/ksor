/**
 * The default AWS region + credential resolution for the keyless Bedrock
 * provider — read from the ambient environment, NOT from a bearer-key env.
 *
 * Kept dependency-free on purpose (decision 12): rather than pull the AWS SDK's
 * credential-provider chain, the operator exports standard AWS variables into
 * the environment — exactly what `aws configure export-credentials`, an
 * instance role's metadata shim, or a `.env` produced from one already does.
 * Credentials are read at CALL time through the `CredentialProvider`, so a
 * rotated SSO/STS token is picked up without rebuilding the provider.
 *
 * If a deployment needs the full SDK credential chain (profiles, SSO
 * auto-refresh, IMDS), it supplies its own `credentials` through the provider's
 * `clientFactory`/constructor — the seam takes it. This is the zero-dependency
 * default, not the only option.
 */

import type { AwsCredentials, CredentialProvider } from "./bedrock-cohere-rest.js";

/** The region for Bedrock, from the standard AWS environment variables. */
export function defaultAwsRegion(): string {
  const region = process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"] || "";
  if (region === "") {
    throw new Error(
      "bedrock-cohere: no AWS region — set AWS_REGION (or AWS_DEFAULT_REGION) to the region " +
        "your Bedrock model runs in (e.g. AWS_REGION=ca-central-1)",
    );
  }
  return region;
}

/** Resolve credentials from the standard AWS environment variables at call
 * time. A session token is optional (long-lived keys have none; SSO/STS
 * temporary credentials require it). */
export function defaultCredentialProvider(): CredentialProvider {
  return async (): Promise<AwsCredentials> => {
    const accessKeyId = process.env["AWS_ACCESS_KEY_ID"] || "";
    const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"] || "";
    if (accessKeyId === "" || secretAccessKey === "") {
      throw new Error(
        "bedrock-cohere: no AWS credentials in the environment — export AWS_ACCESS_KEY_ID and " +
          "AWS_SECRET_ACCESS_KEY (plus AWS_SESSION_TOKEN for SSO/STS credentials). " +
          "`aws configure export-credentials --profile <p> --format env` prints them.",
      );
    }
    const sessionToken = process.env["AWS_SESSION_TOKEN"];
    return sessionToken !== undefined && sessionToken !== ""
      ? { accessKeyId, secretAccessKey, sessionToken }
      : { accessKeyId, secretAccessKey };
  };
}

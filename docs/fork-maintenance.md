# Salman Paracha fork maintenance

This repository is a temporary product fork used by the AWS HealthLake KSoR
proof of concept. Development is paused while waiting for Panaversity's final
upstream work. This guide prevents a future maintainer from confusing fork-only
code with upstream or replacing a deployed artifact without reproducing it.

## Remote and release boundaries

- `origin` is `https://github.com/salmanparacha/ksor.git` and is the only
  writable remote.
- `upstream` is `https://github.com/panaversity/ksor` and must remain
  fetch-only. Never push to it or open a Panaversity PR without a new owner
  decision.
- Every change to this fork lands through a pull request; never push directly
  to `main`.
- The HealthLake POC is pinned to GitHub Release `v0.0.61-salman.5`. It is not
  the Panaversity npm release line.
- `docs/status.md` remains the only authority on what the SDK implements.

Verify the remote safety boundary before syncing:

```sh
git remote -v
git fetch origin
git fetch upstream
git status --short --branch
```

Do not infer equivalence from “ahead” or “behind” counts. Compare the actual
commits and trees:

```sh
git log --oneline --left-right upstream/main...origin/main
git diff --stat upstream/main...origin/main
git diff upstream/main...origin/main -- packages/content packages/content-gateway packages/ksor
```

## Fork-specific compatibility surface

Before adopting an upstream release or dropping a fork commit, prove that the
candidate preserves the behaviors the HealthLake deployment needs:

- keyless `bedrock-titan` provider registration and 1,024-dimensional Titan V2
  embeddings;
- correct SigV4 handling where the Bedrock wire path is encoded once and the
  canonical URI is encoded as SigV4 requires;
- retry and throttling behavior that never converts provider unavailability
  into abstention;
- AgentCore MMDSv2/container credential discovery without long-lived keys;
- `AWS_REGION` visibility in the runtime process;
- transactional `ksor rollback` for a retained generation;
- schema 2.5, generation pinning, cited search, full read, outline,
  provenance, governance, and calibrated abstention.

The exact fork artifact consumed by HealthLake is recorded in that repository's
`package.json` and `system/aws/sdk-release.sha256`. Those two records must move
together.

## Upstream reconciliation procedure

1. Fetch `origin` and fetch-only `upstream` with a clean worktree.
2. Read upstream release notes, `AGENTS.md`, and `docs/status.md`; identify
   changes that overlap the fork-specific compatibility surface.
3. Create a branch from current fork `main`. Merge or rebase only after
   inspecting conflicts semantically; never resolve a provider, auth,
   provenance, or governance conflict by choosing one side wholesale.
4. Run the normal repository gates. CI is authoritative.
5. Pack the real release artifact and test that artifact, not only the source
   checkout.
6. Reproduce the HealthLake record build and a fresh Titan ingest candidate.
   Require zero embedding failures.
7. Run authenticated MCP acceptance against a non-serving candidate: cited
   search, outline, full read, generation pinning, and out-of-corpus abstention.
8. Land the SDK change through a reviewed PR and release airlock. Never publish
   to the `@panaversity` npm scope from this fork.
9. In `salmanparacha/healthlake-ksor`, update the release URL and SHA-256 in a
   separate PR, publish a new source bundle and runtime image, and deploy the
   image by digest through a reviewed CloudFormation change set.
10. Keep the prior SDK artifact, image digest, and database generation until
    rollback has been demonstrated.

If upstream now contains equivalent implementations, remove fork patches one
at a time with regression evidence. “Upstream has a Titan provider” is not by
itself evidence that its signing, credential, throttling, and AgentCore paths
match the deployed contract.

## Paused-project posture

While waiting for upstream:

- do not add features to the fork;
- accept only critical security, data-integrity, authentication, availability,
  or deployment fixes needed by the running POC;
- record other findings as future work rather than widening this fork;
- keep the HealthLake consumer pinned to `v0.0.61-salman.5` unless an upgrade
  completes the full reconciliation procedure;
- periodically fetch upstream for visibility, without merging automatically.

The deployed system's inventory, client setup, publication, cost, and teardown
procedures live in the
[HealthLake maintenance guide](https://github.com/salmanparacha/healthlake-ksor/blob/main/docs/maintenance.md).

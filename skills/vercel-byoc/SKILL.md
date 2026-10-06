---
name: vercel-byoc
description: Deploy an existing app with Vercel Bring Your Own Cloud (BYOC), so Vercel serves the deployment while its functions run as AWS Lambda functions in the user's own AWS account. Use when the user asks to deploy with BYOC, run their Vercel functions in their AWS account, or provision the output of `vercel deploy describe`.
---

# Vercel BYOC

Vercel builds and serves the deployment. The app's functions are created as AWS Lambda functions in the user's AWS account, and Vercel invokes them there.

```text
link → deploy init → build --id → deploy describe → provision → deploy continue → verify
```

Work with the user's existing app. Don't scaffold a new one, add test routes, or change its framework, regions or env setup.

This skill directory contains:

- `scripts/provision.mjs`: creates the Lambda functions and layers listed in `descriptor.json`. Uses the AWS CLI, no dependencies.
- `references/aws-setup.md`: IAM roles and registering the AWS account with Vercel. Read it only if those aren't set up yet.

## Before you start

Requirements: macOS or Linux (`vercel deploy describe` doesn't run on Windows), Node 20+, AWS CLI v2 and `jq`.

Install the latest Vercel CLI and check it has the BYOC commands:

```bash
npm i -g vercel@latest
vercel deploy describe --help 2>&1 | grep -q "deploy describe" && echo ok
```

Older CLIs print the general `deploy` help instead, so check for the `deploy describe` heading, not just the exit code. If it's missing, stop. Don't fall back to a normal `vercel deploy`.

Get these from the user or the existing config, and ask for whatever is missing in one message:

- Vercel team ID (`team_...`) and project. The target defaults to `preview`.
- AWS profile, the 12-digit AWS account ID, and the Lambda execution role ARN.
- Confirmation that BYOC is enabled for the team and that the AWS account is registered with Vercel. If not, see `references/aws-setup.md`.

Check both logins point where they should:

```bash
vercel whoami
aws sts get-caller-identity --query Account --output text
```

BYOC supports regular serverless functions only. Edge Functions, container runtimes and services aren't supported. If the app uses them, tell the user which outputs are affected instead of changing the app.

## 1. Link the project

From the app directory (for a monorepo, the app's root directory):

```bash
vercel link --yes --team "$team_id" --project "$project_name"
vercel pull --yes --environment "$target" --scope "$team_id"
```

If the project doesn't exist yet, confirm that with `vercel project inspect "$project_name" --scope "$team_id"` before running `vercel project add`. An auth or network error doesn't mean it's missing.

## 2. Create the deployment

```bash
mkdir -p .vercel/byoc
vercel deploy init --yes --target "$target" --scope "$team_id" --json > .vercel/byoc/init.json
id=$(jq -er '.deployment.id // .id' .vercel/byoc/init.json)
```

Use this one `id` for every step that follows. On a retry, reuse the saved ID instead of creating another deployment.

## 3. Build and describe

```bash
vercel build --id "$id" --target "$target" --yes
vercel deploy describe --id "$id" --aws-account-id "$aws_account_id" --json
```

`deploy describe` writes to `.vercel/$id/`: `descriptor.json`, the function and layer ZIPs, and a copy of the original build. It also replaces `.vercel/output` with a version that has no function code and includes `provision.json`. It doesn't create anything in AWS.

`.vercel/` now contains code and environment values. Don't print the descriptor or ZIPs, don't commit them, and don't use `set -x`.

If the app changes before you continue, rerun `build` and `deploy describe` with the same `id`.

## 4. Provision in AWS

Use the user's own provisioning setup if they have one. Otherwise use the bundled script. It prints a plan first, and only creates resources with `--apply`:

```bash
node "<skill dir>/scripts/provision.mjs" --descriptor ".vercel/$id/descriptor.json" --role "$execution_role_arn"
node "<skill dir>/scripts/provision.mjs" --descriptor ".vercel/$id/descriptor.json" --role "$execution_role_arn" --apply
```

Show the user the plan (account, regions, function names, role) before applying.

With `--apply`, it checks the AWS account, publishes or reuses layers, creates each regional function, waits until it's Active, and checks code and config. It never updates or deletes an existing function, and stops on a conflict. It records what it created in `.vercel/$id/provisioned.json`; keep that file for retries and cleanup.

The script uploads ZIPs directly, which AWS limits to 50 MB. For bigger ZIPs, upload them to a private S3 bucket in the same region and create the function from there with the same settings.

Vercel's invocation role must be allowed to call the new functions (`lambda:InvokeFunction`) before you continue. See `references/aws-setup.md`.

## 5. Continue the deployment

```bash
vercel deploy continue --id "$id" --scope "$team_id"
vercel inspect "$id" --scope "$team_id"
```

Wait for READY. If something fails and can't be fixed, mark the deployment as failed instead of leaving it waiting:

```bash
vercel deploy continue --id "$id" --scope "$team_id" --error "<short reason>"
```

## 6. Verify

Pick an existing dynamic route from the app (read its routes or smoke tests; don't assume `/api/health` exists) and call it on this exact deployment:

```bash
vercel curl "$route" --deployment "$id" --scope "$team_id" -- --fail-with-body --silent --show-error
```

A static page alone doesn't prove the function ran in AWS. A static-only app can't exercise BYOC; say so.

Report the deployment URL, the AWS account and regions, the functions created, the route check result, and anything you couldn't verify.

## Troubleshooting

- **`deploy describe` not found:** the CLI is too old, or a different `vercel` is first on `PATH`. Check `command -v vercel`.
- **Scope or project mismatch:** run `vercel pull --yes` for the intended project and team, and check `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.
- **Deployment not found from `deploy describe`:** BYOC isn't enabled for the team, or the deployment isn't waiting for provisioning.
- **AWS `AccessDenied`:** the provisioning credentials lack Lambda permissions or `iam:PassRole` on the execution role. A failed read doesn't mean the function is missing.
- **Existing function conflicts:** stop. Don't overwrite or delete a function you didn't create.
- **`ASSUME_ROLE_FAILED`:** fix the invocation role's trust policy (see `references/aws-setup.md`), not its permissions.
- **READY but the route fails:** check deployment protection, that every regional function is Active, and outbound network access from the functions.

AWS errors and logs can include env values or signed URLs. Summarize them; don't paste them.

## Cleanup

Only when the user asks. Deleting the Vercel deployment doesn't delete the AWS functions. Delete only what `provisioned.json` marks as created for this deployment, and check that layers aren't used by other functions first. Don't remove the AWS account registration or the invocation role; other projects can depend on them.

# AWS setup

Read this only when the user's AWS account isn't set up for BYOC yet. If they already have roles and a registration, inspect and reuse them.

## What you need from Vercel

BYOC has to be enabled for the team. Get these from the user's Vercel contact:

- Confirmation that BYOC is enabled for the team.
- The AWS principal ARN that's allowed to assume the invocation role.
- Any outbound network destinations the functions must reach, if the account restricts egress.

A 404 or access error from these APIs doesn't prove the account is unregistered. Ask instead of guessing.

## Three identities

Keep these separate:

| Identity                             | Used by                       | Needs                                                                                                  |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Provisioner (the user's AWS profile) | `provision.mjs`               | Lambda create/read/list, publish/get layer, tag, and `iam:PassRole` on the execution role              |
| Lambda execution role                | The running functions         | Trust `lambda.amazonaws.com`, CloudWatch Logs writes, plus whatever the app needs                      |
| Vercel invocation role               | Vercel, to call the functions | Trust Vercel's principal with the team ID as external ID, and `lambda:InvokeFunction` on the functions |

Don't grant AdministratorAccess. Scope `iam:PassRole` to the execution role, ideally with `iam:PassedToService = lambda.amazonaws.com`.

## Create the execution role

```bash
aws iam create-role --role-name byoc-lambda-execution \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name byoc-lambda-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Use the returned role ARN as `execution_role_arn`.

## Create the invocation role

Trust policy, with real values filled in:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "<VERCEL_PRINCIPAL_ARN>" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "<TEAM_ID>" } }
    }
  ]
}
```

Create it with `--max-session-duration 43200`. For an existing registration, keep its registered external ID.

After `vercel deploy describe` runs, allow it to invoke the new functions. Build the ARNs from `functions[].configuration.FunctionName` and `functions[].region` in `descriptor.json`, and add them with `aws iam put-role-policy`. Do this before `vercel deploy continue`.

## Register the AWS account with Vercel

Run from the linked app directory. Check whether it's already registered:

```bash
vercel api "/teams/$team_id/private-cloud/accounts" --scope "$team_id" --method GET --raw
```

If not, register it with the invocation role's name:

```bash
mkdir -p .vercel/byoc
jq -n --arg account "$aws_account_id" --arg role "$invocation_role_name" \
  '{awsAccountId: $account, roleName: $role}' > .vercel/byoc/account.json
vercel api "/teams/$team_id/private-cloud/accounts" --scope "$team_id" --method POST --input .vercel/byoc/account.json --raw
```

A 409 means it already exists. Inspect it; don't delete and recreate it.

Then refresh the credentials:

```bash
vercel api "/teams/$team_id/private-cloud/accounts/$aws_account_id/refresh" --scope "$team_id" --method POST --raw
```

Check that `credentialsExpiresAt` is in the future. Right after creating the role, IAM can take a minute to catch up, so retry briefly. If `ASSUME_ROLE_FAILED` persists, fix the principal, external ID or max session duration.

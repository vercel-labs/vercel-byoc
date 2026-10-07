# vercel-byoc

An agent skill for deploying an existing app with Vercel Bring Your Own Cloud (BYOC). Vercel builds and serves the deployment, and the app's functions run as AWS Lambda functions in your own AWS account.

## Install

```bash
npx skills add vercel-labs/vercel-byoc
```

Or copy [`skills/vercel-byoc`](skills/vercel-byoc) into your agent's skills directory (for example `~/.claude/skills/`).

## What it does

From your app's directory, ask your agent something like "Deploy this app with BYOC as a preview". The skill walks it through:

1. Linking the Vercel project
2. `vercel deploy init`, `vercel build --id` and `vercel deploy describe`
3. Creating the functions in your AWS account with [`scripts/provision.mjs`](skills/vercel-byoc/scripts/provision.mjs). It shows a plan first, never overwrites existing functions, and records what it created.
4. `vercel deploy continue`, then checking a real route on the deployment

Account and IAM setup is in [`references/aws-setup.md`](skills/vercel-byoc/references/aws-setup.md).

Requirements: Vercel CLI 62.7.0, a Vercel team with BYOC enabled, macOS or Linux, Node 20+, AWS CLI v2 and `jq`.

## Development

```bash
npm test
```

The tests use a fake AWS client and don't create cloud resources.

## License

MIT

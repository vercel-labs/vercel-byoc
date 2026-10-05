#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const maxDirectUpload = 50 * 1024 * 1024;

async function awsCli(args) {
  try {
    const { stdout } = await exec(
      "aws",
      [...args, "--output", "json", "--no-cli-pager"],
      {
        env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 360_000,
      },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (cause) {
    // Avoid echoing AWS responses, environment values or signed download URLs.
    const code = /\(([A-Za-z0-9]+Exception)\)/.exec(cause.stderr ?? "")?.[1];
    const error = new Error(
      `AWS ${args[0]} ${args[1]} failed (${code ?? cause.code ?? "unknown error"})`,
    );
    error.awsCode = code;
    throw error;
  }
}

async function artifact(root, path) {
  assert.equal(typeof path, "string", "Missing artifact path");
  const absolute = await realpath(resolve(root, path));
  const rel = relative(root, absolute);
  assert(
    rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`),
    "Artifact must be inside the descriptor directory",
  );
  const bytes = await readFile(absolute);
  assert(
    bytes.length > 0 && bytes.length <= maxDirectUpload,
    "Empty ZIP or ZIP exceeds the helper's 50 MiB direct-upload limit; use private S3 staging",
  );
  assert.equal(bytes.subarray(0, 2).toString(), "PK", "Artifact is not a ZIP");
  const digest = createHash("sha256").update(bytes).digest();
  return {
    path: absolute,
    size: bytes.length,
    hex: digest.toString("hex"),
    base64: digest.toString("base64"),
  };
}

function matchesConfiguration(actual, expected, tags) {
  for (const [key, value] of Object.entries(expected)) {
    const observed =
      key === "Tags"
        ? tags
        : key === "Layers"
          ? (actual.Layers ?? []).map((layer) => layer.Arn)
          : actual[key];
    if (!isDeepStrictEqual(observed, value)) return key;
  }
  return undefined;
}

export async function provision({
  descriptorPath,
  roleArn,
  apply = false,
  aws = awsCli,
  log = console.log,
}) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal(descriptor.version, 1, "Unsupported descriptor version");
  assert.match(descriptor.awsAccountId, /^\d{12}$/);
  assert.match(descriptor.deploymentId, /^dpl_[a-zA-Z0-9]+$/);
  assert.match(
    roleArn,
    new RegExp(
      `^arn:aws:iam::${descriptor.awsAccountId}:role/[A-Za-z0-9+=,.@_/-]+$`,
    ),
    "Execution role must belong to the descriptor's AWS account",
  );
  assert(descriptor.functions?.length > 0, "No functions to provision");
  const root = await realpath(dirname(descriptorPath));
  const layers = {};
  const functions = [];
  const keys = new Set();
  for (const fn of descriptor.functions) {
    assert.match(
      fn.region,
      /^[a-z]{2}-[a-z]+-\d+$/,
      "Expected an AWS region, not a Vercel region",
    );
    assert.match(fn.configuration.FunctionName, /^[A-Za-z0-9_-]{1,64}$/);
    assert(Array.isArray(fn.layers), "Missing layers array");
    for (const key of ["Code", "Role", "Layers"])
      assert(!(key in fn.configuration), `Unexpected configuration.${key}`);
    const key = `${fn.region}:${fn.configuration.FunctionName}`;
    assert(!keys.has(key), "Duplicate regional function");
    keys.add(key);
    const code = await artifact(root, fn.code);
    assert.equal(
      fn.code,
      `zips/${code.hex}.zip`,
      "Function ZIP digest does not match its filename",
    );
    functions.push({ ...fn, artifact: code });
    for (const name of fn.layers) {
      assert.match(name, /^[A-Za-z0-9_-]{1,140}$/);
      layers[name] ??= await artifact(root, descriptor.layers[name]);
    }
  }
  const plan = {
    deploymentId: descriptor.deploymentId,
    awsAccountId: descriptor.awsAccountId,
    executionRole: roleArn,
    functions: functions.map((fn) => ({
      region: fn.region,
      name: fn.configuration.FunctionName,
      digest: fn.artifact.hex,
      bytes: fn.artifact.size,
      layers: fn.layers,
    })),
  };
  log(JSON.stringify(plan, null, 2));
  if (!apply) return plan;

  const identity = await aws(["sts", "get-caller-identity"]);
  assert.equal(
    identity.Account,
    descriptor.awsAccountId,
    "AWS credentials target a different account",
  );

  const inventoryPath = resolve(root, "provisioned.json");
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    assert.equal(
      inventory.deploymentId,
      descriptor.deploymentId,
      "Inventory deployment mismatch",
    );
    assert.equal(
      inventory.awsAccountId,
      descriptor.awsAccountId,
      "Inventory account mismatch",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    inventory = {
      deploymentId: descriptor.deploymentId,
      awsAccountId: descriptor.awsAccountId,
      functions: [],
      layers: [],
    };
  }
  async function record(kind, item) {
    const existing = inventory[kind].find((entry) => entry.arn === item.arn);
    if (existing)
      Object.assign(existing, item, {
        created: existing.created || item.created,
      });
    else inventory[kind].push(item);
    await writeFile(
      `${inventoryPath}.tmp`,
      JSON.stringify(inventory, null, 2),
      { mode: 0o600 },
    );
    await rename(`${inventoryPath}.tmp`, inventoryPath);
  }

  const regionalLayers = new Map();
  for (const fn of functions) {
    const lambda = (operation, args = []) =>
      aws(["lambda", operation, "--region", fn.region, ...args]);
    const layerArns = [];
    for (const name of fn.layers) {
      const key = `${fn.region}:${name}`;
      if (!regionalLayers.has(key)) {
        const file = layers[name];
        const versions = await lambda("list-layer-versions", [
          "--layer-name",
          name,
        ]);
        let arn;
        for (const version of versions.LayerVersions ?? []) {
          const candidate = await lambda("get-layer-version", [
            "--layer-name",
            name,
            "--version-number",
            String(version.Version),
          ]);
          if (candidate.Content.CodeSha256 === file.base64) {
            arn = candidate.LayerVersionArn;
            break;
          }
        }
        const created = !arn;
        if (!arn) {
          const published = await lambda("publish-layer-version", [
            "--layer-name",
            name,
            "--zip-file",
            `fileb://${file.path}`,
          ]);
          arn = published.LayerVersionArn;
        }
        assert(
          arn?.startsWith(
            `arn:aws:lambda:${fn.region}:${descriptor.awsAccountId}:layer:${name}:`,
          ),
          "Unexpected layer ARN",
        );
        await record("layers", { arn, region: fn.region, name, created });
        regionalLayers.set(key, arn);
      }
      layerArns.push(regionalLayers.get(key));
    }

    const name = fn.configuration.FunctionName;
    const expected = { ...fn.configuration, Role: roleArn, Layers: layerArns };
    const arn = `arn:aws:lambda:${fn.region}:${descriptor.awsAccountId}:function:${name}`;
    let created = false;
    try {
      await lambda("get-function", ["--function-name", name]);
    } catch (error) {
      if (error.awsCode !== "ResourceNotFoundException") throw error;
      // Keep the environment out of command arguments and terminal output.
      const input = resolve(root, ".create-function.json");
      try {
        await writeFile(input, JSON.stringify(expected), { mode: 0o600 });
        await lambda("create-function", [
          "--cli-input-json",
          `file://${input}`,
          "--zip-file",
          `fileb://${fn.artifact.path}`,
        ]);
        created = true;
      } finally {
        await rm(input, { force: true });
      }
    }
    await record("functions", {
      arn,
      name,
      region: fn.region,
      created,
      verified: false,
    });
    await aws([
      "lambda",
      "wait",
      "function-active-v2",
      "--region",
      fn.region,
      "--function-name",
      name,
    ]);
    const remote = await lambda("get-function", ["--function-name", name]);
    assert.equal(
      remote.Configuration.FunctionArn,
      arn,
      "Unexpected function ARN",
    );
    assert.equal(
      remote.Configuration.State,
      "Active",
      "Function is not Active",
    );
    // Do not print expected/actual environment on mismatch.
    if (remote.Configuration.CodeSha256 !== fn.artifact.base64)
      throw new Error(`Function ${name} conflicts: code digest differs`);
    const mismatch = matchesConfiguration(
      remote.Configuration,
      expected,
      remote.Tags ?? {},
    );
    if (mismatch)
      throw new Error(`Function ${name} conflicts: ${mismatch} differs`);
    await record("functions", {
      arn,
      name,
      region: fn.region,
      created,
      verified: true,
      codeSha256: fn.artifact.base64,
    });
    log(`Verified ${arn}`);
  }
  log(`All regional functions verified. Inventory: ${inventoryPath}`);
  return inventory;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        descriptor: { type: "string" },
        role: { type: "string" },
        apply: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: node provision.mjs --descriptor <descriptor.json> --role <execution-role-arn> [--apply]\nDefault: local validation and plan only. --apply creates AWS resources.",
      );
    } else {
      assert(
        values.descriptor && values.role,
        "Provide --descriptor and --role (or --help)",
      );
      await provision({
        descriptorPath: values.descriptor,
        roleArn: values.role,
        apply: values.apply,
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

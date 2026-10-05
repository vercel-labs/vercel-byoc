import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { provision } from "../skills/vercel-byoc/scripts/provision.mjs";

const account = "123456789012";
const roleArn = `arn:aws:iam::${account}:role/test-execution`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "byoc-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "zips"));
  await mkdir(join(root, "layers"));
  // ZIP contents are opaque to the helper; this fixture tests transfer and hashes.
  const zip = Buffer.from("PK-function");
  const digest = createHash("sha256").update(zip).digest("hex");
  await writeFile(join(root, "zips", `${digest}.zip`), zip);
  await writeFile(join(root, "layers/runtime.zip"), "PK-runtime");
  const descriptor = {
    version: 1,
    deploymentId: "dpl_test",
    awsAccountId: account,
    layers: { runtime: "layers/runtime.zip" },
    functions: ["us-east-1", "eu-west-1"].map((region) => ({
      region,
      code: `zips/${digest}.zip`,
      layers: ["runtime"],
      configuration: {
        FunctionName: "test-function",
        Runtime: "nodejs22.x",
        Handler: "index.handler",
        Architectures: ["arm64"],
        Environment: { Variables: { SENSITIVE_VALUE: "do-not-print" } },
        Tags: { owner: "test" },
        MemorySize: 1024,
        Timeout: 30,
      },
    })),
  };
  const descriptorPath = join(root, "descriptor.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const output = [];
  return {
    root,
    descriptor,
    options: { descriptorPath, roleArn, log: (line) => output.push(line) },
    output,
  };
}

function fakeAws() {
  const calls = [];
  const functions = new Map();
  const layers = new Map();
  async function aws(args) {
    calls.push(args);
    const flag = (name) => args[args.indexOf(name) + 1];
    const operation = args[1];
    const region = flag("--region");
    const functionKey = `${region}:test-function`;
    if (operation === "get-caller-identity") return { Account: account };
    if (operation === "list-layer-versions")
      return { LayerVersions: layers.has(region) ? [{ Version: 1 }] : [] };
    if (operation === "get-layer-version") return layers.get(region);
    if (operation === "publish-layer-version") {
      const bytes = await readFile(flag("--zip-file").slice("fileb://".length));
      const layer = {
        LayerVersionArn: `arn:aws:lambda:${region}:${account}:layer:runtime:1`,
        Content: {
          CodeSha256: createHash("sha256").update(bytes).digest("base64"),
        },
      };
      layers.set(region, layer);
      return layer;
    }
    if (operation === "get-function") {
      if (!functions.has(functionKey)) {
        const error = new Error("absent");
        error.awsCode = "ResourceNotFoundException";
        throw error;
      }
      return functions.get(functionKey);
    }
    if (operation === "create-function") {
      const config = JSON.parse(
        await readFile(
          flag("--cli-input-json").slice("file://".length),
          "utf8",
        ),
      );
      const bytes = await readFile(flag("--zip-file").slice("fileb://".length));
      const { Tags, Layers, ...rest } = config;
      const result = {
        Configuration: {
          ...rest,
          Layers: Layers.map((Arn) => ({ Arn })),
          FunctionArn: `arn:aws:lambda:${region}:${account}:function:test-function`,
          State: "Active",
          CodeSha256: createHash("sha256").update(bytes).digest("base64"),
        },
        Tags,
      };
      functions.set(functionKey, result);
      return result.Configuration;
    }
    if (operation === "wait") {
      assert.equal(args[2], "function-active-v2");
      return {};
    }
    throw new Error(`Unexpected AWS operation ${operation}`);
  }
  return { aws, calls, functions, layers };
}

test("plan validates artifacts without calling AWS or printing environment", async (t) => {
  const { options, output } = await fixture(t);
  const plan = await provision({
    ...options,
    aws: () => assert.fail("Plan called AWS"),
  });
  assert.equal(plan.functions.length, 2);
  assert.equal(plan.awsAccountId, account);
  assert(!output.join("").includes("do-not-print"));
});

test("wrong account stops before any resource mutation", async (t) => {
  const { options } = await fixture(t);
  const calls = [];
  await assert.rejects(
    provision({
      ...options,
      apply: true,
      aws: async (args) => {
        calls.push(args);
        return { Account: "000000000000" };
      },
    }),
    /different account/,
  );
  assert.deepEqual(calls, [["sts", "get-caller-identity"]]);
});

test("provisions all regions, preserves configuration, and retries without creating resources", async (t) => {
  const { options, descriptor, root, output } = await fixture(t);
  const fake = fakeAws();
  const inventory = await provision({ ...options, apply: true, aws: fake.aws });
  assert.equal(inventory.functions.length, 2);
  assert.equal(inventory.layers.length, 2);
  assert(inventory.functions.every((fn) => fn.created && fn.verified));
  for (const fn of descriptor.functions) {
    const remote = fake.functions.get(`${fn.region}:test-function`);
    for (const [key, value] of Object.entries(fn.configuration))
      assert.deepEqual(
        key === "Tags" ? remote.Tags : remote.Configuration[key],
        value,
      );
    assert.equal(remote.Configuration.Role, roleArn);
    assert.equal(
      remote.Configuration.Layers[0].Arn,
      `arn:aws:lambda:${fn.region}:${account}:layer:runtime:1`,
    );
  }
  await assert.rejects(readFile(join(root, ".create-function.json")), {
    code: "ENOENT",
  });
  fake.calls.length = 0;
  const retry = await provision({ ...options, apply: true, aws: fake.aws });
  assert.deepEqual(retry, inventory);
  assert(
    !fake.calls.some((args) =>
      ["create-function", "publish-layer-version"].includes(args[1]),
    ),
  );
  assert.equal(fake.calls.filter((args) => args[1] === "wait").length, 2);
  assert(!output.join("").includes("do-not-print"));
});

for (const mismatch of ["CodeSha256", "Environment"]) {
  test(`existing ${mismatch} mismatch fails without overwriting`, async (t) => {
    const { options } = await fixture(t);
    const fake = fakeAws();
    await provision({ ...options, apply: true, aws: fake.aws });
    const fn = fake.functions.get("us-east-1:test-function");
    fn.Configuration[mismatch] =
      mismatch === "CodeSha256"
        ? "wrong"
        : { Variables: { SENSITIVE_VALUE: "different-secret" } };
    fake.calls.length = 0;
    await assert.rejects(
      provision({ ...options, apply: true, aws: fake.aws }),
      (error) =>
        error.message.includes("conflicts") &&
        !error.message.includes("secret"),
    );
    assert(
      !fake.calls.some((args) =>
        /^(create|update|delete)-function/.test(args[1]),
      ),
    );
  });
}

test("AccessDenied is not treated as a missing function", async (t) => {
  const { options } = await fixture(t);
  const fake = fakeAws();
  const aws = async (args) => {
    if (args[1] === "get-function") {
      const error = new Error("denied");
      error.awsCode = "AccessDeniedException";
      throw error;
    }
    return fake.aws(args);
  };
  await assert.rejects(provision({ ...options, apply: true, aws }), /denied/);
  assert(!fake.calls.some((args) => args[1] === "create-function"));
});

test("failed readiness leaves an inventory of created resources and stops later regions", async (t) => {
  const { options, root } = await fixture(t);
  const fake = fakeAws();
  await assert.rejects(
    provision({
      ...options,
      apply: true,
      aws: (args) =>
        args[1] === "wait"
          ? Promise.reject(new Error("wait failed"))
          : fake.aws(args),
    }),
    /wait failed/,
  );
  const inventory = JSON.parse(
    await readFile(join(root, "provisioned.json"), "utf8"),
  );
  assert.equal(inventory.functions.length, 1);
  assert.equal(inventory.functions[0].created, true);
  assert.equal(inventory.functions[0].verified, false);
  assert.equal(fake.functions.size, 1);
  assert.equal(inventory.layers.length, 1);
});

test("a modified ZIP fails before contacting AWS", async (t) => {
  const { options, root, descriptor } = await fixture(t);
  await writeFile(join(root, descriptor.functions[0].code), "PK-modified");
  await assert.rejects(
    provision({
      ...options,
      apply: true,
      aws: () => assert.fail("AWS called"),
    }),
    /digest/,
  );
});

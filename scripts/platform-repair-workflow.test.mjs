import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { workflow, step, tempDir } from "./test-support/release-fixtures.mjs";

const release = workflow("release.yml");
const helper = workflow("helper-artifacts.yml");
const sourceChoice =
  "${{ github.event_name == 'workflow_dispatch' && inputs.source_ref || github.sha }}";

// Evaluate only these repository-owned workflow boolean/JSON expressions, not
// user input. This verifies the actual matrices rather than a duplicated list.
function evaluate(
  expression,
  {
    event = "workflow_dispatch",
    platform = "macos",
    source = "",
    ref = "refs/heads/repair",
  } = {},
) {
  const code = expression.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const inputs = { platform, source_ref: source };
  const github = {
    event_name: event,
    ref,
    sha: "b".repeat(40),
    event: { inputs },
  };
  return Function(
    "github",
    "inputs",
    "fromJSON",
    `"use strict"; return (${code});`,
  )(github, inputs, JSON.parse);
}

function gitFixture(t) {
  const root = tempDir(t);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Workflow Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        `core.hooksPath=${path.join(root, "disabled-hooks")}`,
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const tag = "remote-v4.0.21-r1";
  git("init");
  fs.writeFileSync(
    path.join(root, "release-identity.json"),
    JSON.stringify({ current: { releaseTag: tag } }),
  );
  git("add", "release-identity.json");
  git("commit", "-m", "synthetic tagged release source");
  const sourceSha = git("rev-parse", "HEAD");
  git("tag", "-a", tag, "-m", "synthetic annotated release tag");
  git("tag", "remote-v4.0.21-r2"); // Same commit, wrong metadata identity.
  git("commit", "--allow-empty", "-m", "synthetic repaired workflow");
  const workflowSha = git("rev-parse", "HEAD");
  git("checkout", "--detach", sourceSha);
  const resolve = step(
    release.jobs.identity,
    "Resolve and validate source commit",
  ).run;
  const run = (sourceRef) => {
    const output = path.join(root, "source-output.txt");
    if (fs.existsSync(output)) fs.unlinkSync(output);
    const stdout = execFileSync("bash", ["-c", resolve], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SOURCE_REF: sourceRef,
        GITHUB_SHA: workflowSha,
        GITHUB_OUTPUT: "source-output.txt",
      },
    });
    return { stdout, output: fs.readFileSync(output, "utf8") };
  };
  return { root, git, tag, sourceSha, workflowSha, run };
}

test("mac-only repair selects macos-15 without scheduling existing Windows/Linux artifacts", () => {
  for (const [flow, job, count] of [
    [release, release.jobs.release, 4],
    [helper, helper.jobs["build-helper"], 3],
  ]) {
    const expression = job.strategy.matrix.include;
    assert.equal(typeof expression, "string");
    assert.deepEqual(
      evaluate(expression).map((row) => row.os),
      ["macos-15"],
    );
    assert.equal(evaluate(expression, { platform: "all" }).length, count);
    assert.equal(
      evaluate(expression, { event: "push", platform: "macos" }).length,
      count,
    );
    assert.ok(
      evaluate(expression, { platform: "all" }).every(
        (row) => row.os !== "macos-14",
      ),
    );
    for (const platform of ["linux-x64", "linux-arm64"]) {
      const rows = evaluate(expression, { platform });
      assert.equal(rows.length, 1);
      assert.match(rows[0].os, /^ubuntu-/);
    }
    assert.equal(flow.concurrency["cancel-in-progress"], false);
    assert.match(flow.concurrency.group, /platform/);
    assert.equal(flow.on.workflow_dispatch.inputs.source_ref.type, "string");
  }
  assert.deepEqual(
    evaluate(release.jobs.release.strategy.matrix.include, {
      platform: "windows",
    }).map((row) => row.os),
    ["windows-2022"],
  );
});

test("source override is manual-only and all build/publish checkouts are pinned to the resolved commit", () => {
  for (const [flow, resolverName, builderName] of [
    [release, "identity", "release"],
    [helper, "source", "build-helper"],
  ]) {
    const resolver = flow.jobs[resolverName];
    const checkout = resolver.steps.find((item) =>
      item.uses?.startsWith("actions/checkout"),
    );
    assert.equal(checkout.with.ref, sourceChoice);
    assert.equal(
      step(resolver, "Resolve and validate source commit").env.SOURCE_REF,
      sourceChoice,
    );
    assert.equal(
      resolver.outputs["source-sha"],
      "${{ steps.source.outputs.source-sha }}",
    );
    const expected = "${{ needs." + resolverName + ".outputs.source-sha }}";
    const builder = flow.jobs[builderName];
    assert.equal(builder.needs, resolverName);
    assert.equal(builder.env.SOURCE_SHA, expected);
    assert.match(
      step(builder, "Verify pinned source checkout").run,
      /git rev-parse --verify 'HEAD\^\{commit\}'/,
    );
    for (const [name, job] of Object.entries(flow.jobs)) {
      if (name === resolverName) continue;
      for (const item of job.steps.filter((item) =>
        item.uses?.startsWith("actions/checkout"),
      ))
        assert.equal(item.with.ref, expected);
    }
  }
  assert.equal(
    evaluate(sourceChoice, { source: "remote-v4.0.21-r1" }),
    "remote-v4.0.21-r1",
  );
  assert.equal(
    evaluate(sourceChoice, { event: "push", source: "remote-v4.0.21-r1" }),
    "b".repeat(40),
  );
  assert.equal(
    step(helper.jobs.source, "Validate checked-out helper identity").run,
    "node scripts/release-identity.mjs",
  );
  assert.match(
    step(release.jobs.identity, "Validate build or new public tag").run,
    /node scripts\/release-identity\.mjs --github-output/,
  );
});

test("source resolution peels the requested release tag instead of using the workflow branch SHA", (t) => {
  const f = gitFixture(t);
  assert.notEqual(f.sourceSha, f.workflowSha);
  assert.equal(
    step(release.jobs.identity, "Resolve and validate source commit").run,
    step(helper.jobs.source, "Resolve and validate source commit").run,
  );
  for (const ref of [f.tag, `refs/tags/${f.tag}`, f.sourceSha]) {
    const result = f.run(ref);
    assert.equal(result.output.trim(), `source-sha=${f.sourceSha}`);
    assert.match(
      result.stdout,
      new RegExp(`source ${f.sourceSha} \\(workflow event ${f.workflowSha}\\)`),
    );
  }
});

test("source resolution fails on moving branches, wrong commits, tag identity drift and shell injection", (t) => {
  const f = gitFixture(t);
  for (const ref of [
    "main",
    "refs/heads/main",
    f.sourceSha.slice(0, 8),
    f.workflowSha,
    "remote-v4.0.21-r2",
    "remote-v4.0.21-r99",
    "$(touch injected)",
  ]) {
    assert.throws(() => f.run(ref));
    assert.equal(fs.existsSync(path.join(f.root, "source-output.txt")), false);
  }
  assert.equal(fs.existsSync(path.join(f.root, "injected")), false);
});

test("every Cargo/Tauri build stamps actual source SHA using a process-local override", () => {
  const builds = [
    ...release.jobs.release.steps,
    ...helper.jobs["build-helper"].steps,
  ].filter((item) => /cargo build|pnpm tauri build/.test(item.run ?? ""));
  assert.equal(builds.length, 5);
  for (const item of builds) {
    const assignment =
      item.shell === "pwsh"
        ? "$env:GITHUB_SHA = $env:SOURCE_SHA"
        : 'export GITHUB_SHA="$SOURCE_SHA"';
    assert.ok(item.run.includes(assignment), item.name);
    assert.ok(
      item.run.indexOf(assignment) <
        item.run.search(/cargo build|pnpm tauri build/),
      item.name,
    );
    assert.doesNotMatch(
      item.run,
      /(?:echo|printf).*GITHUB_SHA.*>>.*GITHUB_ENV/,
    );
  }
  const prepare = step(
    helper.jobs["build-helper"],
    "Prepare helper artifact",
  ).run;
  assert.match(prepare, /short_sha="\$\{SOURCE_SHA::8\}"/);
  assert.doesNotMatch(prepare, /GITHUB_SHA/);
});

test("helper single-platform/source-ref repairs cannot publish or delete existing rolling assets", () => {
  const publish = helper.jobs["publish-helper-release"];
  assert.deepEqual(publish.needs, ["source", "build-helper"]);
  for (const platform of ["macos", "linux-x64", "linux-arm64"]) {
    for (const source of ["", "remote-v4.0.21-r1"]) {
      assert.equal(
        evaluate(publish.if, { platform, source, ref: "refs/heads/main" }),
        false,
      );
    }
  }
  assert.equal(
    evaluate(publish.if, {
      platform: "all",
      source: "remote-v4.0.21-r1",
      ref: "refs/heads/main",
    }),
    false,
  );
  assert.equal(
    evaluate(publish.if, { platform: "all", ref: "refs/heads/repair" }),
    false,
  );
  assert.equal(
    evaluate(publish.if, { platform: "all", ref: "refs/heads/main" }),
    true,
  );
  assert.equal(
    evaluate(publish.if, { event: "push", ref: "refs/heads/main" }),
    true,
  );
  const mutate = step(publish, "Publish remote-helper-latest release").run;
  assert.match(mutate, /git tag -f "\$TAG" "\$SOURCE_SHA"/);
  assert.doesNotMatch(mutate, /GITHUB_SHA/);
  for (const [name, job] of Object.entries(helper.jobs)) {
    if (name === "publish-helper-release") continue;
    assert.ok(
      job.steps.every(
        (item) =>
          !/gh release (?:create|edit|upload|delete)|git (?:push|tag -f)/.test(
            item.run ?? "",
          ),
      ),
    );
  }
  assert.equal(
    release.jobs["publish-release"].if,
    "github.event_name == 'push' && needs.identity.outputs.release-ready == 'true'",
  );
});

test("macOS universal targets and signing/notarization verification stay in the original pipeline", () => {
  const job = release.jobs.release;
  assert.match(
    step(job, "Add macOS targets").run,
    /aarch64-apple-darwin x86_64-apple-darwin/,
  );
  assert.match(
    step(job, "Build Tauri App (macOS)").run,
    /--target universal-apple-darwin/,
  );
  assert.match(
    step(job, "Verify macOS code signing and notarization").run,
    /codesign --verify/,
  );
  assert.match(
    step(job, "Verify macOS code signing and notarization").run,
    /spctl -a/,
  );
  assert.match(step(job, "Notarize macOS DMG").run, /xcrun notarytool submit/);
  assert.match(step(job, "Clean up Apple signing keychain").if, /always\(\)/);
  assert.match(
    step(helper.jobs["build-helper"], "Build remote helper CLI").run,
    /lipo -create/,
  );
});

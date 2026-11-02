import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs, validateDescriptor, verifyArchive, powershellArgs, powershellEnvironment } from "../npm/cli.mjs";

test("independent pinned launcher contracts without installation or network", async (t) => {
  const scratch = process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT;
  assert.ok(scratch);
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, "0");
  assert.equal(process.env.AGENTMEMORY_CURATE, "0");
  const root = await mkdtemp(join(scratch, "launcher-"));
  try {
    const paths = ["--install-root", "D:\\synthetic\\install", "--workspace-root", "D:\\synthetic\\workspace",
      "--project-registry", "D:\\synthetic\\registry.json"];
    await t.test("dry-run is default; conflicting or repeated operations cannot acquire execute", () => {
      assert.equal(parseArgs(paths).execute, undefined);
      assert.throws(() => parseArgs([...paths, "--fresh", "--activate-prepared"]));
      assert.throws(() => parseArgs([...paths, "--execute", "--execute"]));
      assert.equal(parseArgs([...paths, "--fresh", "--execute"]).execute, true);
    });
    await t.test("relative, network and control-bearing paths are refused", () => {
      for (const value of ["relative", "\\\\synthetic-host\\share", "D:\\synthetic\npath", 'D:\\synthetic"path']) {
        assert.throws(() => parseArgs(["--install-root", value, ...paths.slice(2)]));
      }
    });
    const bytes = Buffer.from("synthetic archive bytes, never a release");
    const descriptor = { schema_version: 1, product_id: "agentmemory-codex-windows", version: "0.1.0-preview.19",
      source_commit: "a".repeat(40), archive_sha256: createHash("sha256").update(bytes).digest("hex"),
      manifest_sha256: "b".repeat(64), archive_bytes: bytes.length,
      url: "https://github.com/M-T-D-N/agentmemory-codex-windows/releases/download/v0.1.0-preview.19/agentmemory-codex-windows-0.1.0-preview.19-win32-x64.zip" };
    await t.test("descriptor binds product version repository and exact download identity", () => {
      assert.equal(validateDescriptor(descriptor), descriptor);
      for (const change of [{ url: descriptor.url + "?other" }, { version: "0.1.0-preview.18" },
        { source_commit: "not-a-commit" }, { archive_bytes: 0 }, { product_id: "other-product" }]) {
        assert.throws(() => validateDescriptor({ ...descriptor, ...change }));
      }
    });
    await t.test("matching bytes pass; same-size corruption and truncated archives fail", async () => {
      const path = join(root, "synthetic.zip");
      await writeFile(path, bytes); await verifyArchive(path, descriptor);
      await writeFile(path, Buffer.alloc(bytes.length, 120));
      await assert.rejects(verifyArchive(path, descriptor), /integrity mismatch/);
      await writeFile(path, bytes.subarray(1));
      await assert.rejects(verifyArchive(path, descriptor), /integrity mismatch/);
    });
    await t.test("named Windows arguments remain separate and mixed-case environment cannot silently conflict", () => {
      const args = powershellArgs("D:\\synthetic path\\installer.ps1", { InstallRoot: "D:\\synthetic path\\install", Execute: true });
      assert.equal(args[args.indexOf("-InstallRoot") + 1], "D:\\synthetic path\\install");
      assert.equal(args.at(-1), "-Execute");
      assert.throws(() => powershellEnvironment({ Path: "first", PATH: "second" }), /Conflicting/);
      const input = { Path: "synthetic-toolchain", SystemRoot: "C:\\Windows", PSModulePath: "synthetic-untrusted" };
      const env = powershellEnvironment(input);
      assert.equal(env.PATH, input.Path);
      assert.equal(input.PSModulePath, "synthetic-untrusted");
      assert.equal(env.PSMODULEPATH, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

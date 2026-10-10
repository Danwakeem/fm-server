import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { patchSdk } = (await import(
  new URL("../../scripts/patch-sdk.js", import.meta.url).href
)) as {
  patchSdk(path: string): boolean;
};
const sdkDir = dirname(dirname(fileURLToPath(import.meta.resolve("javascript-apple-fm-sdk"))));
const patchFile = fileURLToPath(
  new URL("../../patches/javascript-apple-fm-sdk@0.1.0.patch", import.meta.url),
);
const files = ["session.js", "session.d.ts", "generable.js", "generation-schema.js"];
let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "fm-sdk-patch-"));
  mkdirSync(join(fixture, "dist"));
  writeFileSync(join(fixture, "package.json"), '{"version":"0.1.0"}');
  for (const file of files) copyFileSync(join(sdkDir, "dist", file), join(fixture, "dist", file));
  execFileSync("/usr/bin/patch", ["-R", "-p1", "--batch", "-i", patchFile], { cwd: fixture });
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

test("npm installation applies the same SDK patch as pnpm and is idempotent", () => {
  expect(patchSdk(fixture)).toBe(true);
  for (const file of files) {
    expect(readFileSync(join(fixture, "dist", file), "utf8")).toBe(
      readFileSync(join(sdkDir, "dist", file), "utf8"),
    );
  }
  expect(patchSdk(fixture)).toBe(false);
});

test("an unexpected SDK source fails before any files are modified", () => {
  const path = join(fixture, "dist/session.js");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "ManagedObject.call(session, ptr)",
      "ManagedObject.apply(session, [ptr])",
    ),
  );
  const before = files.map((file) => readFileSync(join(fixture, "dist", file), "utf8"));
  expect(() => patchSdk(fixture)).toThrow();
  expect(files.map((file) => readFileSync(join(fixture, "dist", file), "utf8"))).toEqual(before);
});

test("an SDK version change requires reviewing the patch", () => {
  writeFileSync(join(fixture, "package.json"), '{"version":"0.2.0"}');
  expect(() => patchSdk(fixture)).toThrow("Review the fm-server SDK patch");
});

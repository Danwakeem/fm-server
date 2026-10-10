import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const patchFile = fileURLToPath(
  new URL("../patches/javascript-apple-fm-sdk@0.1.0.patch", import.meta.url),
);

/** Apply the pinned SDK repairs for npm installs; pnpm applies this patch itself. */
export function patchSdk(sdkDir) {
  const version = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
  if (version !== "0.1.0")
    throw new Error(
      "Review the fm-server SDK patch before changing javascript-apple-fm-sdk versions.",
    );
  const session = readFileSync(join(sdkDir, "dist/session.js"), "utf8");
  const generable = readFileSync(join(sdkDir, "dist/generable.js"), "utf8");
  const schema = readFileSync(join(sdkDir, "dist/generation-schema.js"), "utf8");
  const types = readFileSync(join(sdkDir, "dist/session.d.ts"), "utf8");
  if (
    session.includes("Reflect.construct(ManagedObject") &&
    session.includes('addEventListener("abort"') &&
    generable.includes("meta.nestedSchema = nested") &&
    schema.includes("array<${meta.nestedSchema.name}>") &&
    types.includes("signal?: AbortSignal")
  )
    return false;
  const args = ["-p1", "--batch", "--forward", "--reject-file=-", "-i", patchFile];
  execFileSync("/usr/bin/patch", ["--dry-run", ...args], { cwd: sdkDir });
  execFileSync("/usr/bin/patch", args, { cwd: sdkDir });
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entry = createRequire(import.meta.url).resolve("javascript-apple-fm-sdk");
  patchSdk(dirname(dirname(entry)));
}

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI exit status", () => {
  it("treats explicit help as success", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dewey index");
  });
  it("rejects an unknown command", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "unknown-command"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });
});

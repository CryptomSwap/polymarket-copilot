import { spawn } from "child_process";
import type { ValidationCheckResult } from "./contracts";

export type ValidationCheckName = "lint" | "typecheck" | "relevant_tests" | "repo_diagnostics" | "paper_smoke";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CHECK_COMMANDS: Record<ValidationCheckName, string[]> = {
  lint: ["npm", "run", "lint"],
  typecheck: ["npx", "tsc", "--noEmit"],
  relevant_tests: ["npm", "run", "test:paper-score-alignment"],
  repo_diagnostics: ["npm", "run", "dump:post-boot-runtime-validation-report"],
  paper_smoke: ["npm", "run", "dump:current-paper-blocker-report"],
};

function runCommand(argv: string[], timeoutMs: number): Promise<ValidationCheckResult> {
  const [cmd, ...args] = argv;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32",
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      output += String(buf);
    });
    child.stderr.on("data", (buf) => {
      output += String(buf);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      resolve({
        name: "unknown",
        command: argv.join(" "),
        passed: !timedOut && code === 0,
        exitCode: timedOut ? null : code,
        durationMs,
        output: (timedOut ? "Timed out. " : "") + output.slice(-8000),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      resolve({
        name: "unknown",
        command: argv.join(" "),
        passed: false,
        exitCode: null,
        durationMs,
        output: `Failed to start command: ${err.message}`,
      });
    });
  });
}

export async function runValidationChecks(
  checks: ValidationCheckName[]
): Promise<{
  pass: boolean;
  checks: ValidationCheckResult[];
}> {
  const results: ValidationCheckResult[] = [];
  for (const check of checks) {
    const cmd = CHECK_COMMANDS[check];
    const result = await runCommand(cmd, DEFAULT_TIMEOUT_MS);
    results.push({
      ...result,
      name: check,
    });
    if (!result.passed) {
      // Fail-closed: stop on first failure.
      return { pass: false, checks: results };
    }
  }
  return { pass: true, checks: results };
}

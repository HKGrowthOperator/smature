#!/usr/bin/env node
// Test-Doppel für `claude -p`: protokolliert Aufruf (Argumente, Umgebung, Dateien) und liefert eine vorgegebene Antwort.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => { input += d; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const files = readdirSync(process.cwd());
  const systemFile = args[args.indexOf("--system-prompt-file") + 1];
  const call = {
    args, files, stdin: input, cwd: process.cwd(),
    env: Object.keys(process.env).sort(),
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
    system: systemFile && existsSync(systemFile) ? readFileSync(systemFile, "utf8") : null
  };
  const logFile = join(home, "calls.jsonl");
  writeFileSync(logFile, (existsSync(logFile) ? readFileSync(logFile, "utf8") : "") + JSON.stringify(call) + "\n");
  const next = join(home, "next-response.json");
  const response = existsSync(next) ? JSON.parse(readFileSync(next, "utf8")) : { structured_output: {} };
  if (response.exit) process.exit(response.exit);
  const result = {
    type: "result", subtype: response.subtype || "success", is_error: !!response.is_error, num_turns: 2,
    result: response.result ?? JSON.stringify(response.structured_output ?? {}),
    structured_output: response.is_error ? undefined : response.structured_output,
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  };
  process.stdout.write(JSON.stringify(result));
});

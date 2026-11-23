import { DEFAULT_MAX_STATES } from "@tsverify/checker";
import { type CAC, type Command, cac } from "cac";
import pkg from "../package.json" with { type: "json" };
import { camelCaseBooleanFlags } from "./argv";
import { type CheckCommandOptions, checkCommand } from "./commands/check";
import { type DiffCommandOptions, diffCommand } from "./commands/diff";
import { type RenderCommandOptions, renderCommand } from "./commands/render";
import { schemaCommand } from "./commands/schema";
import { type TestCommandOptions, testCommand } from "./commands/test";
import { type ValidateCommandOptions, validateCommand } from "./commands/validate";
import { type ViewCommandOptions, viewCommand } from "./commands/view";
import { ExitCode, SetupError, UsageError } from "./exit-codes";
import { helpText } from "./help";
import type { Io } from "./io";
import { DIFF_FORMATS } from "./output/diff";
import { OUTPUT_FORMATS } from "./output/format";

export type { Io } from "./io";

const VERSION: string = pkg.version;
const FORMAT_HELP = `Output format: ${OUTPUT_FORMATS.join(" | ")}`;
const STRICT_HELP =
  "Report `unanalyzable` warnings as errors (exit 1), so code tsverify cannot analyze cannot hide a finding";

const ENFORCED_ONLY_HELP =
  "Keep only specs with `enforced: true` (and invalid ones); none left is an empty run (exit 0)";

/**
 * Runs `tsverify` with `argv` (the arguments after the program name) and returns the exit code.
 * Never exits the process and never throws: unexpected exceptions become exit code 3.
 */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    io.stderr(
      `tsverify: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    return ExitCode.Internal;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const cli = program(io);
  cli.parse(["node", "tsverify", ...camelCaseBooleanFlags(argv, cli)], { run: false });
  const command = cli.matchedCommand;

  if (cli.options.help) {
    io.stdout(helpText(cli, VERSION, command));
    return ExitCode.Ok;
  }
  if (cli.options.version && command === undefined) {
    io.stdout(`${VERSION}\n`);
    return ExitCode.Ok;
  }
  if (command === undefined) {
    const name = cli.args[0];
    return usage(io, cli, name === undefined ? "missing command" : `unknown command \`${name}\``);
  }
  try {
    return await cli.runMatchedCommand();
  } catch (e) {
    if (isUsageError(e)) return usage(io, cli, e.message, command);
    if (e instanceof SetupError) {
      io.stderr(`error: ${e.message}\n`);
      return ExitCode.InvalidInput;
    }
    throw e;
  }
}

/** The command table. Each action returns its exit code; `run` awaits it. */
function program(io: Io): CAC {
  const cli = cac("tsverify");
  // Registered as plain options rather than `cli.help()` / `cli.version()`, which print to the
  // console themselves.
  cli.option("-h, --help", "Display this message");
  cli.option("-v, --version", "Display version number");

  cli
    .command("validate [...paths]", "Parse and validate behavior specs (files or directories)")
    .option("--format <format>", FORMAT_HELP, { default: "pretty" })
    .action((paths: string[], options: ValidateCommandOptions) =>
      validateCommand(io, paths, options),
    );

  cli
    .command(
      "check [...paths]",
      "Validate and model-check behavior specs, then check that the code conforms to them",
    )
    .option("--format <format>", FORMAT_HELP, { default: "pretty" })
    .option("--max-states <n>", "Stop exploring a model after this many states", {
      default: DEFAULT_MAX_STATES,
    })
    .option("--spec-only", "Check the specs only: skip code extraction and conformance")
    .option("--enforced-only", ENFORCED_ONLY_HELP)
    .option("--strict", STRICT_HELP)
    .option(
      "--project <path>",
      "TypeScript project for all specs: its root directory, or its tsconfig file (default: per spec, the nearest tsconfig.json dir)",
    )
    .action((paths: string[], options: CheckCommandOptions) => checkCommand(io, paths, options));

  cli
    .command(
      "test [...paths]",
      "Generate vitest tests from the specs and the code (paths, forbidden states, guards, counterexample replays) into <project>/.tsverify/generated/ and run them",
    )
    .option("--format <format>", FORMAT_HELP, { default: "pretty" })
    .option("--max-states <n>", "Stop exploring a model after this many states", {
      default: DEFAULT_MAX_STATES,
    })
    .option(
      "--project <path>",
      "TypeScript project for all specs: its root directory, or its tsconfig file (default: per spec, the nearest tsconfig.json dir)",
    )
    .option("--enforced-only", ENFORCED_ONLY_HELP)
    .option("--strict", STRICT_HELP)
    .action((paths: string[], options: TestCommandOptions) => testCommand(io, paths, options));

  cli
    .command(
      "diff [...paths]",
      "Behavior diff between the specs at a git ref and the working tree (Markdown for a PR comment by default)",
    )
    .option("--base <git-ref>", "The git ref to compare with, e.g. origin/main (required)")
    .option("--format <format>", `Output format: ${DIFF_FORMATS.join(" | ")}`, {
      default: "markdown",
    })
    .option("--enforced-only", "Keep only specs with `enforced: true` on either side")
    .action((paths: string[], options: DiffCommandOptions) => diffCommand(io, paths, options));

  cli
    .command(
      "view [...paths]",
      "Run check and serve its results in a local browser viewer (diagram, matrix, summary, findings, counterexample playback) that reloads when the specs or code change",
    )
    .option("--port <n>", "Port to listen on; 0 picks a free one", { default: 0 })
    .option("--host <address>", "Loopback address to listen on (127.0.0.1, ::1 or localhost)", {
      default: "127.0.0.1",
    })
    .option("--open", "Open the viewer in the default browser")
    .option("--max-states <n>", "Stop exploring a model after this many states", {
      default: DEFAULT_MAX_STATES,
    })
    .option("--spec-only", "Check the specs only: skip code extraction and conformance")
    .option("--enforced-only", ENFORCED_ONLY_HELP)
    .option(
      "--project <path>",
      "TypeScript project for all specs: its root directory, or its tsconfig file (default: per spec, the nearest tsconfig.json dir)",
    )
    .action((paths: string[], options: ViewCommandOptions) => viewCommand(io, paths, options));

  cli
    .command("render <spec>", "Render one spec (default: --mermaid)")
    .option("--mermaid", "Mermaid stateDiagram-v2")
    .option("--matrix", "Markdown actor × transition permission matrix")
    .option("--summary", "Plain-English Markdown summary")
    .action((spec: string, options: RenderCommandOptions) => renderCommand(io, spec, options));

  cli.command("schema", "Print the JSON Schema of *.behavior.yaml").action(() => schemaCommand(io));

  return cli;
}

function usage(io: Io, cli: CAC, message: string, command?: Command): number {
  io.stderr(`error: ${message}\n\n${helpText(cli, VERSION, command)}`);
  return ExitCode.InvalidInput;
}

/** Our own usage errors, plus cac's (unknown option, missing value or argument, extra args). */
function isUsageError(e: unknown): e is Error {
  return e instanceof UsageError || (e instanceof Error && e.name === "CACError");
}

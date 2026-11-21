import { type CAC, type Command, cac } from "cac";
import pkg from "../package.json" with { type: "json" };
import { schemaCommand } from "./commands/schema";
import { ExitCode, UsageError } from "./exit-codes";
import { helpText } from "./help";
import type { Io } from "./io";

export type { Io } from "./io";

const VERSION: string = pkg.version;

/**
 * Runs `tsv` with `argv` (the arguments after the program name) and returns the exit code.
 * Never exits the process and never throws: unexpected exceptions become exit code 3.
 */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    io.stderr(`tsv: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return ExitCode.Internal;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const cli = program(io);
  cli.parse(["node", "tsv", ...argv], { run: false });
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
    throw e;
  }
}

/** The command table. Each action returns its exit code; `run` awaits it. */
function program(io: Io): CAC {
  const cli = cac("tsv");
  // Registered as plain options rather than `cli.help()` / `cli.version()`, which print to the
  // console themselves.
  cli.option("-h, --help", "Display this message");
  cli.option("-v, --version", "Display version number");

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

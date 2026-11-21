import { specJsonSchema } from "@tsv/spec";
import { ExitCode } from "../exit-codes";
import type { Io } from "../io";

/** `tsv schema`: the JSON Schema of `*.behavior.yaml`, for yaml-language-server and agents. */
export function schemaCommand(io: Io): ExitCode {
  io.stdout(`${JSON.stringify(specJsonSchema(), null, 2)}\n`);
  return ExitCode.Ok;
}

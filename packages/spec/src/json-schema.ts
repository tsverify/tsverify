import { z } from "zod";
import { specSchema } from "./schema";

/** JSON Schema (draft 2020-12) of the YAML input format, for yaml-language-server and agents. */
export function specJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(specSchema, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

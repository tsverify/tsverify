// The `tsv` bin entry: the only module that touches the real process. Everything else goes
// through the injected `Io` (see main.ts).
import { main } from "./main";

process.exitCode = await main(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
  isTTY: process.stdout.isTTY === true,
  env: process.env,
});

import type { CAC, Command } from "cac";

/**
 * Help text built from cac's command metadata. cac's own `outputHelp()` writes straight to
 * `console.info`, which would bypass the injected `Io`, so the text is assembled here instead.
 */
export function helpText(cli: CAC, version: string, command?: Command): string {
  const global = cli.globalCommand;
  const sections: string[] = [];

  if (command === undefined) {
    sections.push(`${cli.name}/${version}`);
    sections.push(`Usage:\n  $ ${cli.name} <command> [options]`);
    sections.push(`Commands:\n${table(cli.commands.map((c) => [c.rawName, c.description]))}`);
    sections.push(
      `For more info, run any command with the \`--help\` flag:\n${cli.commands
        .map((c) => `  $ ${cli.name} ${c.name} --help`)
        .join("\n")}`,
    );
    sections.push(`Options:\n${optionTable(global.options)}`);
  } else {
    sections.push(`Usage:\n  $ ${cli.name} ${command.rawName} [options]`);
    if (command.description) sections.push(command.description);
    const options = [...command.options, ...global.options.filter((o) => o.name !== "version")];
    sections.push(`Options:\n${optionTable(options)}`);
  }
  return `${sections.join("\n\n")}\n`;
}

function optionTable(options: Command["options"]): string {
  return table(
    options.map((o) => [
      o.rawName,
      o.config.default === undefined
        ? o.description
        : `${o.description} (default: ${String(o.config.default)})`,
    ]),
  );
}

function table(rows: [string, string][]): string {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, text]) => `  ${name.padEnd(width)}  ${text}`.trimEnd()).join("\n");
}

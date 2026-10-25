/**
 * The subcommand contract. Every `agent-ci` subcommand is one module that
 * exports a `CommandSpec`; `cli.ts` owns parsing the command name, the single
 * stdout envelope, and the exit code. Workflow steps with more than about a
 * dozen lines of logic become new specs registered in `registry.ts`.
 */

/** Process facts a command may read; injected so tests never touch globals. */
export interface CommandContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Diagnostics go to stderr; stdout is reserved for the envelope. */
  readonly log: (message: string) => void;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /**
   * True for a command with subcommands that prints each subcommand's own
   * usage: `cli.ts` then passes `<command> <sub> --help` through to `run`
   * and intercepts only a bare `<command> --help`.
   */
  readonly ownsHelp?: boolean;
  /**
   * Run the command and return the envelope `data`. Throw `CliError` for an
   * expected failure; anything else becomes `E_UNEXPECTED`.
   */
  run(argv: readonly string[], context: CommandContext): Promise<unknown>;
}

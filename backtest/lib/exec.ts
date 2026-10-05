// Fixed-argv subprocess helper. No shell, no eval, no interpolation of transcript or candidate
// text into an argv: every call site passes a constant program plus literal arguments.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runFixed(argv: string[], cwd?: string): ExecResult {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = command.outputSync();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

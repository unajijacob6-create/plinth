// Command-line flags for the tools. A flag a script does not know is an error, not ignored.

export interface Args {
  /** `--flag value` pairs. */
  values: Record<string, string>;
  /** `--flag` switches that were given. */
  switches: Set<string>;
  positionals: string[];
}

/** Parse `argv` against the flags a script accepts. Throws with a readable message on an unknown
 *  flag, a flag given twice, or a value flag without a value. */
export function parseArgs(argv: string[], spec: { values?: string[]; switches?: string[] }): Args {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  const positionals: string[] = [];
  const valueFlags = new Set(spec.values ?? []), switchFlags = new Set(spec.switches ?? []);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
    } else if (valueFlags.has(a)) {
      const v = argv[++i];
      if (v === undefined || (v.startsWith("--") && valueFlags.has(v)) || switchFlags.has(v)) throw new UsageError(`${a} needs a value`);
      if (a in values) throw new UsageError(`${a} given twice`);
      values[a] = v;
    } else if (switchFlags.has(a)) {
      switches.add(a);
    } else {
      throw new UsageError(`unknown flag ${a} (known: ${[...valueFlags, ...switchFlags].sort().join(" ")})`);
    }
  }
  return { values, switches, positionals };
}

/** Bad command-line input. `withUsage` prints it with the usage text and exits 2. */
export class UsageError extends Error {}

/** Run `fn`; a UsageError is printed with the usage text and exits 2. Other errors pass through. */
export function withUsage<T>(usageText: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${(e as Error).message}\n\n${usageText}`);
    process.exit(2);
  }
}

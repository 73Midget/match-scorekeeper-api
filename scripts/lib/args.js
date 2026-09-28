/**
 * Reading the command-line arguments these scripts share.
 *
 * Every script here takes the same shape: one positional value — a club id, a
 * match key — plus flags, some of which consume the argument after them. That
 * sounds too simple to need a module, and it produced the same bug twice.
 *
 * THE BUG THIS EXISTS FOR
 *
 * The obvious way to find the positional argument is to take the first one that
 * does not start with "--":
 *
 *     const clubId = args.find((a) => !a.startsWith("--"));
 *
 * A flag's value does not start with "--" either. So in
 *
 *     node scripts/rotate-secret.js --remote --url https://api.example.com x3222665
 *
 * that finds "https://api.example.com" and treats it as the club id. The
 * failure is quiet in the best case — a club that does not exist, reported as
 * nothing to do, which looks identical to a clean database — and in
 * rotate-secret's case it would mean rotating the wrong thing.
 *
 * It happened because the helper was written four times, correctly in some
 * scripts and naively in others. One definition means the next script gets it
 * right without anyone remembering to.
 */

/**
 * The first positional argument, skipping values that belong to flags.
 *
 * @param {string[]} args      Usually process.argv.slice(2).
 * @param {string[]} takesValue Flags that consume the argument after them,
 *                              e.g. ["--older-than", "--url"].
 * @returns {string|null} The positional value, or null if there is none.
 */
export function positional(args, takesValue = []) {
  const consuming = new Set(takesValue);

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Step over this flag's value so it cannot be mistaken for the
      // positional argument.
      if (consuming.has(args[i])) i++;
      continue;
    }

    return args[i];
  }

  return null;
}

/**
 * The value following a flag, or null if absent.
 *
 * Returns null rather than the next flag when a value is missing, so
 *
 *     --out --again
 *
 * fails the caller's own validation instead of writing a backup into a
 * directory named "--again". Callers decide whether a missing value is an error
 * or means "use the default"; this only reports what is there.
 *
 * @param {string[]} args
 * @param {string}   flag e.g. "--url"
 * @returns {string|null}
 */
export function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;

  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return null;

  return value;
}

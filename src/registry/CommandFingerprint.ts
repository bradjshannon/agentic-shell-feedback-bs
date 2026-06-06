/**
 * Command fingerprinting: reduce a raw command string to a stable "skeleton"
 * that is the same across runs of the *same* command but distinct for genuinely
 * different commands.
 *
 * Why this exists: the pattern signature used to be only the transport shape
 * (`shell:target:multiline:heredoc:transport`). That shape is shared by almost
 * every command — e.g. every simple local command is `bash:local:single:...:inline`
 * — so a couple of unrelated failures could promote a pattern that then blocks
 * *all* commands of that shape. Folding a command fingerprint into the signature
 * keeps learned patterns specific to the command that actually misbehaved.
 *
 * The approach is deliberately conservative ("light touch"): we replace the
 * high-variance parts of a command (heredoc bodies, quoted strings, paths,
 * hosts, URLs, numbers) with placeholders, but leave the command/sub-command
 * words intact. Over-specificity is the safe failure mode here — it means we
 * aggregate *less*, which can only reduce false matches, never increase them.
 */
export function computeCommandFingerprint(command: string): string {
  let s = command ?? "";

  // 1. POSIX heredoc: collapse `<<DELIM ... DELIM` (incl. `<<-` and quoted
  //    delimiters) to a marker — the body varies run to run, the wrapper is
  //    the shape that matters.
  s = s.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?\n[ \t]*\2\b/g, " <<HEREDOC ");
  // Any leftover heredoc opener with no matching close (incomplete command).
  s = s.replace(/<<-?\s*['"]?[A-Za-z_]\w*['"]?/g, " <<HEREDOC ");

  // 2. PowerShell here-strings: @' ... '@  and  @" ... "@
  s = s.replace(/@(['"])[\s\S]*?\1@/g, " HEREDOC ");

  // 3. Quoted strings.
  s = s.replace(/'[^']*'/g, "STR").replace(/"[^"]*"/g, "STR");

  // 4. URLs.
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "URL");

  // 5. ssh/scp-style user@host targets.
  s = s.replace(/\b[\w.-]+@[\w.-]+/g, "HOST");

  // 6. Filesystem paths: Windows drive paths, then POSIX absolute/relative/home.
  s = s.replace(/[A-Za-z]:\\[\w.\\-]*/g, "PATH");
  s = s.replace(/(?:\.{0,2}\/|~\/)[\w./-]*/g, "PATH");

  // 7. Standalone numbers (ports, PIDs, sizes, timestamps). A number that
  //    begins a token but may carry a unit suffix collapses to N.
  s = s.replace(/\b\d[\w.]*\b/g, "N");

  // 8. Drop the signature delimiter so the fingerprint stays a single field.
  s = s.replace(/:/g, " ");

  // 9. Collapse whitespace and bound the length.
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 80).trimEnd() : s;
}

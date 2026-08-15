/** Environments whose body is literal text and must be left untouched. */
const RAW_ENVIRONMENTS = new Set([
	"verbatim",
	"verbatim*",
	"Verbatim",
	"lstlisting",
	"lstlisting*",
	"minted",
	"comment",
	"alltt",
	"filecontents",
	"filecontents*",
]);

const BEGIN_RE = /\\begin\s*\{([^}]*)\}/g;
const END_RE = /\\end\s*\{([^}]*)\}/g;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Formats a LaTeX source string by indenting the contents of each
 *  \begin{...}/\end{...} environment one level relative to its parent.
 *  Verbatim-style environments (verbatim, lstlisting, minted, ...) keep their
 *  body byte-for-byte; only their \begin/\end lines are re-indented. Leading
 *  and trailing whitespace of every other line is trimmed and blank lines are
 *  preserved. */
export function formatLatex(source: string, indent: string): string {
	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = source.split(/\r?\n/);
	const result: string[] = [];
	let depth = 0;
	let rawEnv: string | undefined;

	for (const rawLine of lines) {
		if (rawEnv !== undefined) {
			const endRe = new RegExp(`\\\\end\\s*\\{${escapeRegExp(rawEnv)}\\}`);
			if (endRe.test(rawLine)) {
				result.push(
					indent.repeat(Math.max(0, depth - 1)) + rawLine.trim(),
				);
				depth = Math.max(0, depth - 1);
				rawEnv = undefined;
			} else {
				result.push(rawLine);
			}
			continue;
		}

		const line = rawLine.trim();
		if (line.length === 0) {
			result.push("");
			continue;
		}

		const begins = [...line.matchAll(BEGIN_RE)];
		const ends = [...line.matchAll(END_RE)];

		// A fully balanced environment opened and closed on the same line
		// (\begin{x}...\end{x}) sits at the current depth, like its \begin.
		const balancedInline =
			begins.length > 0 && begins.length === ends.length;
		const startsWithBegin = /^\\begin\s*\{/.test(line);
		const indentLevel = startsWithBegin && balancedInline
			? depth
			: depth - ends.length;

		result.push(indent.repeat(Math.max(0, indentLevel)) + line);

		for (const match of begins) {
			// Do not enter raw mode when the environment is opened and closed
			// on the same line (e.g. \begin{verbatim}x\end{verbatim}).
			if (
				RAW_ENVIRONMENTS.has(match[1]) &&
				!ends.some((end) => end[1] === match[1])
			) {
				rawEnv = match[1];
			}
		}
		depth = Math.max(0, depth + begins.length - ends.length);
	}

	return result.join(eol);
}

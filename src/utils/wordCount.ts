export interface WordCountStats {
	textWords: number;
	headerWords: number;
	captionWords: number;
	footnoteWords: number;
	totalWords: number;
	headers: number;
	tables: number;
	figures: number;
	mathInlines: number;
}

export interface WordCountFileResult extends WordCountStats {
	fileName: string;
	filePath: string;
}

export interface WordCountWorkspaceResult {
	files: WordCountFileResult[];
	total: WordCountStats;
}

interface Ctx {
	type: "text" | "header" | "caption" | "footnote";
	chars: string[];
	depth: number;
}

const SECTION_COMMANDS = new Set([
	"part",
	"chapter",
	"section",
	"subsection",
	"subsubsection",
	"paragraph",
	"subparagraph",
]);

const DISPLAY_MATH_ENVS = new Set([
	"equation",
	"equation*",
	"align",
	"align*",
	"alignat",
	"alignat*",
	"gather",
	"gather*",
	"multline",
	"multline*",
	"flalign",
	"flalign*",
	"eqnarray",
	"eqnarray*",
	"math",
	"math*",
	"displaymath",
	"dmath",
	"dgroup",
]);

const VERBATIM_ENVS = new Set([
	"verbatim",
	"verbatim*",
	"Verbatim",
	"lstlisting",
	"lstlisting*",
	"minted",
	"comment",
]);

const TABLE_ENVS = new Set(["table", "table*"]);

const FIGURE_ENVS = new Set(["figure", "figure*"]);

/** Commands whose brace argument is metadata (paths, keys, refs, URLs) and
 *  should not be counted as prose. */
const IGNORED_ARG_COMMANDS = new Set([
	"includegraphics",
	"includegraphics*",
	"cite",
	"citep",
	"citet",
	"citeauthor",
	"citetitle",
	"citeyear",
	"nocite",
	"ref",
	"pageref",
	"eqref",
	"autoref",
	"vref",
	"cref",
	"Cref",
	"label",
	"index",
	"glossary",
	"bibliography",
	"bibliographystyle",
	"printbibliography",
	"addbibresource",
	"input",
	"include",
	"includeonly",
	"documentclass",
	"usepackage",
	"url",
	"href",
	"textcolor",
	"color",
	"definecolor",
	"includegraphics*",
]);

/**
 * Count words and LaTeX structures in a .tex source string.
 *
 * Only content between \begin{document} and \end{document} is counted; files
 * without a document environment are counted in full. Words are attributed to
 * text, section headers, captions and footnotes separately. The counts for
 * section headers, table/figure environments and inline math ($...$, \(...\))
 * are reported as well.
 */
export function countWordsInSource(source: string): WordCountStats {
	const stats: WordCountStats = {
		textWords: 0,
		headerWords: 0,
		captionWords: 0,
		footnoteWords: 0,
		totalWords: 0,
		headers: 0,
		tables: 0,
		figures: 0,
		mathInlines: 0,
	};

	const docStart = source.indexOf("\\begin{document}");
	let body = source;
	if (docStart >= 0) {
		const docEnd = source.indexOf("\\end{document}", docStart);
		const end =
			docEnd >= 0 ? docEnd + "\\end{document}".length : source.length;
		body = source.slice(docStart, end);
	}

	const src = stripComments(body);
	const stack: Ctx[] = [{ type: "text", chars: [], depth: 0 }];

	let i = 0;
	const n = src.length;

	while (i < n) {
		const ch = src[i];

		if (ch === "\\") {
			const { name, next } = readCommandName(src, i);
			i = handleCommand(src, next, name, stack, stats);
			continue;
		}

		if (ch === "{") {
			stack[stack.length - 1].depth++;
			i++;
			continue;
		}

		if (ch === "}") {
			const top = stack[stack.length - 1];
			if (top.depth > 0) {
				top.depth--;
				if (top.depth === 0 && top.type !== "text") {
					const popped = stack.pop();
					if (popped) {
						const words = countWords(popped.chars.join(""));
						if (popped.type === "header") stats.headerWords += words;
						else if (popped.type === "caption") stats.captionWords += words;
						else if (popped.type === "footnote") stats.footnoteWords += words;
					}
				}
			}
			i++;
			continue;
		}

		if (ch === "$") {
			i = handleInlineMath(src, i, stats);
			continue;
		}

		stack[stack.length - 1].chars.push(ch);
		i++;
	}

	for (const ctx of stack) {
		const words = countWords(ctx.chars.join(""));
		if (ctx.type === "text") stats.textWords += words;
		else if (ctx.type === "header") stats.headerWords += words;
		else if (ctx.type === "caption") stats.captionWords += words;
		else if (ctx.type === "footnote") stats.footnoteWords += words;
	}

	stats.totalWords =
		stats.textWords +
		stats.headerWords +
		stats.captionWords +
		stats.footnoteWords;

	return stats;
}

function handleCommand(
	src: string,
	i: number,
	name: string,
	stack: Ctx[],
	stats: WordCountStats,
): number {
	if (SECTION_COMMANDS.has(name)) {
		const group = findGroupStart(src, i);
		if (src[group] === "{") {
			stack.push({ type: "header", chars: [], depth: 0 });
			stats.headers++;
		}
		return group;
	}

	if (name === "caption" || name === "footnote") {
		const group = findGroupStart(src, i);
		if (src[group] === "{") {
			stack.push({
				type: name === "caption" ? "caption" : "footnote",
				chars: [],
				depth: 0,
			});
		}
		return group;
	}

	if (name === "begin") {
		const env = readEnvName(src, i);
		if (env) {
			const [envName, after] = env;
			if (VERBATIM_ENVS.has(envName) || DISPLAY_MATH_ENVS.has(envName)) {
				return skipToEnd(src, after, envName);
			}
			if (FIGURE_ENVS.has(envName)) stats.figures++;
			if (TABLE_ENVS.has(envName)) stats.tables++;
			return after;
		}
		return i;
	}

	if (name === "end") {
		const env = readEnvName(src, i);
		return env ? env[1] : i;
	}

	if (name === "(") {
		stats.mathInlines++;
		const close = src.indexOf("\\)", i);
		return close < 0 ? src.length : close + 2;
	}

	if (name === "[") {
		const close = src.indexOf("\\]", i);
		return close < 0 ? src.length : close + 2;
	}

	if (IGNORED_ARG_COMMANDS.has(name)) {
		return skipCommandArgs(src, i);
	}

	return i;
}

/** Reads a command name starting at src[i] === "\\". A trailing "*" is part of
 *  the consumed command but not of the returned name. */
function readCommandName(
	src: string,
	i: number,
): { name: string; next: number } {
	const j = i + 1;
	if (j >= src.length) return { name: "", next: j };
	if (/[a-zA-Z@]/.test(src[j])) {
		let k = j;
		while (k < src.length && /[a-zA-Z@]/.test(src[k])) k++;
		const name = src.slice(j, k);
		if (k < src.length && src[k] === "*") k++;
		return { name, next: k };
	}
	return { name: src[j], next: j + 1 };
}

/** Reads \begin{...} (and \end{...}) environment names. Returns the name and
 *  the index just past the closing brace, or undefined. */
function readEnvName(src: string, i: number): [string, number] | undefined {
	while (i < src.length && /\s/.test(src[i])) i++;
	if (src[i] !== "{") return undefined;
	let j = i + 1;
	let name = "";
	while (j < src.length && src[j] !== "}") {
		name += src[j];
		j++;
	}
	if (j >= src.length) return undefined;
	return [name, j + 1];
}

/** Skips whitespace and an optional [...] argument, returning the index of the
 *  next character (expected to be "{"). */
function findGroupStart(src: string, i: number): number {
	while (i < src.length && /\s/.test(src[i])) i++;
	if (src[i] === "[") {
		let j = i + 1;
		while (j < src.length && src[j] !== "]") j++;
		i = j < src.length ? j + 1 : j;
		while (i < src.length && /\s/.test(src[i])) i++;
	}
	return i;
}

/** Skips a whitespace/optional-arg prefix plus one brace group. */
function skipCommandArgs(src: string, i: number): number {
	const group = findGroupStart(src, i);
	if (src[group] === "{") return skipGroup(src, group);
	return group;
}

/** Skips a balanced {...} group starting at src[i] === "{". */
function skipGroup(src: string, i: number): number {
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") {
			depth--;
			if (depth === 0) return j + 1;
		}
	}
	return src.length;
}

function skipToEnd(src: string, i: number, env: string): number {
	const pattern = `\\end{${env}}`;
	const idx = src.indexOf(pattern, i);
	return idx < 0 ? src.length : idx + pattern.length;
}

function handleInlineMath(src: string, i: number, stats: WordCountStats): number {
	if (src[i + 1] === "$") {
		const close = src.indexOf("$$", i + 2);
		return close < 0 ? src.length : close + 2;
	}
	stats.mathInlines++;
	const close = src.indexOf("$", i + 1);
	return close < 0 ? src.length : close + 1;
}

/** Removes LaTeX comments (lines starting with an unescaped %). */
function stripComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "%") {
			let backslashes = 0;
			let j = i - 1;
			while (j >= 0 && text[j] === "\\") {
				backslashes++;
				j--;
			}
			if (backslashes % 2 === 0) {
				const nl = text.indexOf("\n", i);
				if (nl < 0) break;
				out += "\n";
				i = nl + 1;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return out;
}

/** Counts space-separated tokens containing at least one letter. */
function countWords(text: string): number {
	if (!text) return 0;
	let t = text;

	// \verb|...| / \verb*|...| inline verbatim — strip content too.
	t = t.replace(/\\verb\*?([^a-zA-Z]).*?\1/gs, " ");

	// Remaining control sequences and escaped symbols.
	t = t.replace(/\\[a-zA-Z@]+\*?/g, " ");
	t = t.replace(/\\[^a-zA-Z]/g, " ");

	// Braces, brackets and LaTeX special characters.
	t = t.replace(/[{}[\]$&_^~#%]/g, " ");

	const tokens = t.split(/\s+/).filter((tok) => /\p{L}/u.test(tok));
	return tokens.length;
}

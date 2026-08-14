import * as fs from "node:fs";
import * as path from "node:path";

/** fontspec commands that take a font name/filename as their mandatory argument. */
export const FONTSPEC_COMMANDS = new Set([
	"setmainfont",
	"setsansfont",
	"setmonofont",
	"setmathfont",
	"setmathrm",
	"setboldmathrm",
	"setmathsf",
	"setmathtt",
	"setromanfont",
	"setCJKmainfont",
	"setCJKsansfont",
	"setCJKmonofont",
	"setCJKfamilyfont",
]);

/** fontspec commands that take (cmd-name, font-spec). */
export const FONT_FAMILY_COMMANDS = new Set(["newfontfamily", "newfontface"]);

/** fontspec `[...]` option keys whose values are font references. */
const FONT_OPTION_KEYS = [
	"UprightFont",
	"BoldFont",
	"ItalicFont",
	"BoldItalicFont",
	"SmallCapsFont",
	"SlantedFont",
	"BoldSlantedFont",
];

const FONT_OPTION_KEY_PATTERN = new RegExp(
	`(${FONT_OPTION_KEYS.join("|")})\\s*=\\s*\\{([^}]*)\\}`,
	"g",
);

export interface FontIndexEntry {
	family: string;
	fullName?: string;
	postscriptName?: string;
	filePath: string;
	stem: string;
	ext: string;
	dirRelativeToRoot: string;
}

export interface FontResolverOptions {
	workspaceRoots: string[];
	rootDir: string;
	aliases?: Record<string, string>;
	aliasesFileName?: string;
}

export interface UnresolvedFontRef {
	command: string;
	name: string;
	line: number;
	column: number;
	location: "argument" | "option";
	optionKey?: string;
}

export interface ResolveResult {
	source: string;
	rewritten: Array<{ command: string; from: string; to: string; line: number }>;
	unresolved: UnresolvedFontRef[];
}

/* ────────────────────────────── TTF/OTF name table ────────────────────────────── */

interface NameRecord {
	platformID: number;
	encodingID: number;
	languageID: number;
	nameID: number;
	value: string;
}

const NAME_ID_FAMILY = 1;
const NAME_ID_FULL_NAME = 4;
const NAME_ID_POSTSCRIPT = 6;

function readUShortBE(buf: Buffer, off: number): number {
	return (buf[off] << 8) | buf[off + 1];
}

function decodeNameRecord(buf: Buffer, offset: number, length: number, platformID: number, encodingID: number): string {
	const slice = buf.subarray(offset, offset + length);
	if (platformID === 3 && encodingID === 1) {
		// UTF-16BE
		let out = "";
		for (let i = 0; i + 1 < slice.length; i += 2) {
			out += String.fromCharCode((slice[i] << 8) | slice[i + 1]);
		}
		return out;
	}
	if (platformID === 0) {
		// Unicode, also UTF-16BE
		let out = "";
		for (let i = 0; i + 1 < slice.length; i += 2) {
			out += String.fromCharCode((slice[i] << 8) | slice[i + 1]);
		}
		return out;
	}
	if (platformID === 1) {
		// Mac Roman — close enough to ASCII for our purposes
		return slice.toString("latin1");
	}
	// Fallback: lossy decode as latin1
	return slice.toString("latin1");
}

function readNameTable(buf: Buffer): NameRecord[] {
	// 'name' table: starts with 6-byte header, then count × 12-byte records, then string storage
	if (buf.length < 6) return [];
	const count = readUShortBE(buf, 2);
	const stringOffset = readUShortBE(buf, 4);
	const records: NameRecord[] = [];
	for (let i = 0; i < count; i++) {
		const recOff = 6 + i * 12;
		if (recOff + 12 > buf.length) break;
		const platformID = readUShortBE(buf, recOff);
		const encodingID = readUShortBE(buf, recOff + 2);
		const languageID = readUShortBE(buf, recOff + 4);
		const nameID = readUShortBE(buf, recOff + 6);
		const length = readUShortBE(buf, recOff + 8);
		const offset = readUShortBE(buf, recOff + 10);
		if (stringOffset + offset + length > buf.length) continue;
		const value = decodeNameRecord(buf, stringOffset + offset, length, platformID, encodingID);
		records.push({ platformID, encodingID, languageID, nameID, value });
	}
	return records;
}

function findName(records: NameRecord[], nameID: number): string | undefined {
	// Prefer Windows English (3/1/0x0409)
	const winEn = records.find((r) => r.platformID === 3 && r.nameID === nameID && r.languageID === 0x0409);
	if (winEn) return winEn.value;
	// Any Windows entry
	const win = records.find((r) => r.platformID === 3 && r.nameID === nameID);
	if (win) return win.value;
	// Unicode platform
	const uni = records.find((r) => r.platformID === 0 && r.nameID === nameID);
	if (uni) return uni.value;
	// Mac
	const mac = records.find((r) => r.platformID === 1 && r.nameID === nameID);
	if (mac) return mac.value;
	return undefined;
}

/**
 * Read the TTF/OTF "name" table from a font file. Returns family / full / postscript
 * names, or undefined values when missing.
 */
export function readFontNames(filePath: string): { family?: string; fullName?: string; postscriptName?: string } {
	let buf: Buffer;
	try {
		buf = fs.readFileSync(filePath);
	} catch {
		return {};
	}
	// Walk the table directory. The first 12 bytes are the sfnt header
	// (tag + checksum + offset + length). We only need the 'name' table.
	if (buf.length < 12) return {};
	const numTables = readUShortBE(buf, 4);
	for (let i = 0; i < numTables; i++) {
		const dirOff = 12 + i * 16;
		if (dirOff + 16 > buf.length) break;
		const tag = buf.toString("ascii", dirOff, dirOff + 4);
		if (tag !== "name") continue;
		const tableOffset = (readUShortBE(buf, dirOff + 8) << 16) | readUShortBE(buf, dirOff + 10);
		if (tableOffset + 6 > buf.length) break;
		const records = readNameTable(buf.subarray(tableOffset));
		return {
			family: findName(records, NAME_ID_FAMILY),
			fullName: findName(records, NAME_ID_FULL_NAME),
			postscriptName: findName(records, NAME_ID_POSTSCRIPT),
		};
	}
	return {};
}

/* ──────────────────────────────── Index building ──────────────────────────────── */

const FONT_EXTENSIONS = new Set([".otf", ".ttf"]);

const MAX_FONT_INDEX_BYTES = 8 * 1024 * 1024; // skip files larger than this when reading name table

export function buildFontIndex(
	roots: string[],
	rootDir: string,
): Map<string, FontIndexEntry> {
	const index = new Map<string, FontIndexEntry>();
	if (roots.length === 0) return index;

	const visited = new Set<string>();
	for (const root of roots) {
		walk(root, rootDir, index, visited);
	}
	return index;
}

function walk(
	dir: string,
	rootDir: string,
	index: Map<string, FontIndexEntry>,
	visited: Set<string>,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			walk(fullPath, rootDir, index, visited);
			continue;
		}
		if (!entry.isFile()) continue;
		const ext = path.extname(entry.name).toLowerCase();
		if (!FONT_EXTENSIONS.has(ext)) continue;
		const resolved = path.resolve(fullPath);
		if (visited.has(resolved)) continue;
		visited.add(resolved);

		let size = 0;
		try {
			size = fs.statSync(resolved).size;
		} catch {
			continue;
		}
		if (size > MAX_FONT_INDEX_BYTES) continue;

		const names = readFontNames(resolved);
		if (!names.family) continue;

		const entry2: FontIndexEntry = {
			family: names.family,
			fullName: names.fullName,
			postscriptName: names.postscriptName,
			filePath: resolved,
			stem: path.basename(entry.name, ext),
			ext,
			dirRelativeToRoot: relativeDir(rootDir, resolved),
		};
		addToIndex(index, names.family, entry2);
		if (names.fullName && names.fullName !== names.family) {
			addToIndex(index, names.fullName, entry2);
		}
		if (names.postscriptName && names.postscriptName !== names.family) {
			addToIndex(index, names.postscriptName, entry2);
		}
	}
}

function relativeDir(rootDir: string, filePath: string): string {
	const rel = path.relative(rootDir, path.dirname(filePath));
	if (!rel || rel.startsWith("..")) return "";
	return rel.replace(/\\/g, "/");
}

function addToIndex(index: Map<string, FontIndexEntry>, name: string, entry: FontIndexEntry): void {
	const key = name.trim().toLowerCase();
	if (!key) return;
	const existing = index.get(key);
	if (!existing) {
		index.set(key, entry);
		return;
	}
	// Prefer the entry whose family matches the key exactly (vs. fullName/postscript fallback)
	if (entry.family.trim().toLowerCase() === key && existing.family.trim().toLowerCase() !== key) {
		index.set(key, entry);
	}
}

/* ───────────────────────────── Index merging ───────────────────────────── */

/**
 * Merge a workspace font index with a system font index. Workspace entries
 * win on family-name collision (more specific to the project).
 */
export function mergeFontIndices(
	workspace: Map<string, FontIndexEntry>,
	system: Map<string, FontIndexEntry>,
): Map<string, FontIndexEntry> {
	const merged = new Map<string, FontIndexEntry>();
	for (const [k, v] of system.entries()) merged.set(k, v);
	for (const [k, v] of workspace.entries()) merged.set(k, v);
	return merged;
}

/* ──────────────────────── Macro definition extraction ──────────────────────── */

/**
 * Captures LaTeX control-sequence definitions whose replacement text is a
 * simple (brace-delimited) value, e.g.:
 *   \def \fontType {Arial}
 *   \newcommand\fontType{Arial}
 *   \newcommand{\fontType}{Arial}
 *   \providecommand*{\fontType}{Arial}
 * Capture groups: 1 = \def-style name, 2 = \def-style value,
 * 3 = braced \newcommand-style name, 4 = unbraced \newcommand-style name,
 * 5 = \newcommand-style value.
 */
const MACRO_DEFINITION_PATTERN = new RegExp(
	`\\\\(?:def|gdef|edef|xdef)\\s*\\\\?([a-zA-Z@]+)\\s*\\{([^{}]*)\\}|` +
		`\\\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\\*?\\s*(?:\\{\\\\([a-zA-Z@]+)\\}|\\\\([a-zA-Z@]+))\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
	"g",
);

/**
 * Scan `source` for font-holding macros (e.g. `\def \fontType {Arial}`) and
 * return them as a map of macro name (without the leading backslash) to the
 * trimmed replacement text. Used to resolve `\setmainfont{\fontType}` when the
 * font name is stored in a variable. Later definitions win.
 */
export function extractMacroDefinitions(source: string): Map<string, string> {
	const macros = new Map<string, string>();
	let m: RegExpExecArray | null;
	while ((m = MACRO_DEFINITION_PATTERN.exec(source)) !== null) {
		let name: string | undefined;
		let value: string | undefined;
		if (m[1] !== undefined) {
			name = m[1];
			value = m[2];
		} else {
			name = m[3] ?? m[4];
			value = m[5];
		}
		if (name === undefined || value === undefined) continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		// Skip parameterized macros whose body references arguments (#1) — those
		// are not simple font-name values.
		if (/^#\d/.test(trimmed)) continue;
		macros.set(name, trimmed);
	}
	return macros;
}

/** Expand a control sequence through the given macro map (chained definitions). */
function resolveMacroValue(name: string, macros?: ReadonlyMap<string, string>): string {
	let current = name;
	for (let depth = 0; depth < 10; depth++) {
		if (!current.startsWith("\\")) break;
		const next = macros?.get(current.slice(1));
		if (next === undefined) break;
		current = next;
	}
	return current;
}

/* ──────────────────────────── Source rewriter ───────────────────────────────── */

const COMMAND_REGEX = buildCommandRegex();

function buildCommandRegex(): RegExp {
	const cmds = [
		...Array.from(FONTSPEC_COMMANDS),
		...Array.from(FONT_FAMILY_COMMANDS),
	];
	// Sort longest-first so prefixes don't shadow (e.g. setromanfont before setmainfont)
	cmds.sort((a, b) => b.length - a.length);
	const group = cmds.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	// Capture groups:
	//  1 = command name (e.g. "setmainfont", "newfontfamily")
	//  2 = optional [...] options content
	//  3 = font name when no options and no family-command form (single {name})
	//  4 = braced cmd name (for \newfontfamily{foo}{font})
	//  5 = font name for braced family form
	//  6 = unbraced cmd name (for \newfontfamily\foo{font})
	//  7 = font name for unbraced family form
	return new RegExp(
		`\\\\(${group})(?:\\s*\\[([^\\]]*)\\])?\\s*(?:\\\\([a-zA-Z@]+)\\s*\\{([^}]+)\\}|\\{([^}]+)\\}\\s*\\{([^}]+)\\}|\\{([^}]+)\\})`,
		"g",
	);
}

function indexLineCol(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lastNl = -1;
	for (let i = 0; i < offset && i < source.length; i++) {
		if (source[i] === "\n") {
			line++;
			lastNl = i;
		}
	}
	return { line, column: offset - lastNl };
}

function lookupFont(
	name: string,
	index: Map<string, FontIndexEntry>,
	aliases: Record<string, string>,
): { entry?: FontIndexEntry; alias?: string } {
	const trimmed = name.trim();
	if (!trimmed) return {};
	// Already a filename with an extension? Skip.
	if (/\.(otf|ttf|ttc|otc)$/i.test(trimmed)) return {};

	const alias = aliases[trimmed];
	if (alias) return { alias };

	const key = trimmed.toLowerCase();
	const entry = index.get(key);
	if (entry) return { entry };
	return {};
}

function entryToOptions(entry: FontIndexEntry): { opts: string; basename: string } {
	const basename = entry.stem;
	if (!entry.dirRelativeToRoot || entry.dirRelativeToRoot.startsWith("..")) {
		// Font at the project root (or outside the project — system font).
		// Must use Path=./ so fontspec/luaotfload looks in the CWD
		// instead of trying its font database (which doesn't exist in WASM).
		return { opts: `Path=./,Extension=${entry.ext}`, basename };
	}
	return {
		opts: `Path=${entry.dirRelativeToRoot}/,Extension=${entry.ext}`,
		basename,
	};
}

function aliasToOptions(
	alias: string,
	rootDir: string,
): { opts: string; basename: string } {
	const ext = path.extname(alias);
	const basenameWithExt = path.basename(alias);
	const basename = ext ? basenameWithExt.slice(0, -ext.length) : basenameWithExt;
	let dir = path.dirname(alias);
	if (dir === ".") dir = "";

	// Absolute path: convert to relative-from-root
	if (path.isAbsolute(alias) && rootDir) {
		const relDir = path.relative(rootDir, path.dirname(alias));
		if (relDir && !relDir.startsWith("..")) {
			dir = relDir.replace(/\\/g, "/");
		}
	}

	dir = dir.replace(/\\/g, "/");
	const parts: string[] = [];
	if (dir) parts.push(`Path=${dir}/`);
	if (ext) parts.push(`Extension=${ext}`);
	return { opts: parts.join(","), basename };
}

function mergeOptions(existing: string, add: string): string {
	if (!existing) return add;
	if (!add) return existing;
	const seen = new Set<string>();
	for (const part of existing.split(",")) {
		const key = part.split("=")[0].trim();
		if (key) seen.add(key);
	}
	const additions: string[] = [];
	for (const part of add.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const key = trimmed.split("=")[0].trim();
		if (key && seen.has(key)) continue;
		seen.add(key);
		additions.push(trimmed);
	}
	if (additions.length === 0) return existing;
	return `${existing},${additions.join(",")}`;
}

function rewriteOptionsForFontOptions(options: string, index: Map<string, FontIndexEntry>, aliases: Record<string, string>, rootDir: string, unresolved: UnresolvedFontRef[], offset: number, source: string, command: string, macros?: ReadonlyMap<string, string>): string {
	return options.replace(FONT_OPTION_KEY_PATTERN, (match, key: string, value: string) => {
		const resolvedValue = resolveMacroValue(value, macros);
		const hit = lookupFont(resolvedValue, index, aliases);
		if (!hit.entry && !hit.alias) {
			if (/\.(otf|ttf)$/i.test(resolvedValue.trim())) return match;
			const loc = indexLineCol(source, offset + match.indexOf(`${key}={`));
			unresolved.push({
				command,
				name: resolvedValue,
				line: loc.line,
				column: loc.column,
				location: "option",
				optionKey: key,
			});
			return match;
		}
		let basename: string;
		if (hit.entry) {
			basename = entryToOptions(hit.entry).basename;
		} else if (hit.alias) {
			basename = aliasToOptions(hit.alias, rootDir).basename;
		} else {
			basename = resolvedValue;
		}
		return `${key}={${basename}}`;
	});
}

export function resolveFontReferences(
	source: string,
	index: Map<string, FontIndexEntry>,
	aliases: Record<string, string> = {},
	rootDir: string,
	macros?: ReadonlyMap<string, string>,
): ResolveResult {
	const rewritten: ResolveResult["rewritten"] = [];
	const unresolved: UnresolvedFontRef[] = [];
	// Combine caller-supplied macros (e.g. definitions collected from included
	// files) with definitions found in this same source. Same-file definitions
	// win so a local \def\fontType{...} overrides a value from another file.
	const effectiveMacros = new Map<string, string>(macros ?? new Map());
	for (const [name, value] of extractMacroDefinitions(source)) {
		effectiveMacros.set(name, value);
	}
	const out = source.replace(
		COMMAND_REGEX,
		(
			match: string,
			command: string,
			options: string | undefined,
			unbracedCmd: string | undefined,
			unbracedCmdFont: string | undefined,
			bracedCmd: string | undefined,
			bracedCmdFont: string | undefined,
			singleArg: string | undefined,
			offset: number,
		) => {
			const isFamilyCommand = FONT_FAMILY_COMMANDS.has(command);
			let cmdName: string | undefined;
			let name: string | undefined;
			let cmdBraced = false;
			if (isFamilyCommand) {
				if (unbracedCmd !== undefined) {
					cmdName = unbracedCmd;
					name = unbracedCmdFont;
				} else if (bracedCmd !== undefined) {
					cmdName = bracedCmd;
					name = bracedCmdFont;
					cmdBraced = true;
				}
			} else {
				name = singleArg;
			}
			if (name === undefined) return match;

			const loc = indexLineCol(source, offset);
			// Resolve font names stored in macros (e.g. \setmainfont{\fontType}
			// where \fontType is defined via \def\fontType{Arial}).
			const resolvedName = resolveMacroValue(name, effectiveMacros);
			const hit = lookupFont(resolvedName, index, aliases);
			if (!hit.entry && !hit.alias) {
				if (/\.(otf|ttf)$/i.test(resolvedName.trim())) return match;
				unresolved.push({
					command,
					name: resolvedName,
					line: loc.line,
					column: loc.column,
					location: "argument",
				});
				return match;
			}

			let opts: string;
			let basename: string;
			if (hit.entry) {
				const r = entryToOptions(hit.entry);
				opts = r.opts;
				basename = r.basename;
			} else if (hit.alias) {
				const r = aliasToOptions(hit.alias, rootDir);
				opts = r.opts;
				basename = r.basename;
			} else {
				opts = "";
				basename = resolvedName;
			}

			let newOptions = options ?? "";
			if (opts) {
				newOptions = mergeOptions(newOptions, opts);
			}
			// Check option-level font references (UprightFont=, BoldFont=, ...)
			if (newOptions) {
				newOptions = rewriteOptionsForFontOptions(
					newOptions,
					index,
					aliases,
					rootDir,
					unresolved,
					offset,
					source,
					command,
					effectiveMacros,
				);
			}

			const optsStr = newOptions ? `[${newOptions}]` : "";
			const replacement = isFamilyCommand && cmdName !== undefined
				? `\\${command}${optsStr}${cmdBraced ? `{${cmdName}}` : `\\${cmdName}`}{${basename}}`
				: `\\${command}${optsStr}{${basename}}`;

			rewritten.push({ command, from: resolvedName, to: basename, line: loc.line });
			return replacement;
		},
	);

	return { source: out, rewritten, unresolved };
}

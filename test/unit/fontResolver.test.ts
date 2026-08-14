import { describe, it, beforeEach, afterEach } from "mocha";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildFontIndex,
	extractMacroDefinitions,
	mergeFontIndices,
	readFontNames,
	resolveFontReferences,
} from "../../src/engine/fontResolver";

const testDir = path.resolve(__dirname, "../../.test_temp_fonts");

/**
 * Synthesize a minimal TTF-like file with a valid 'name' table.
 * The sfnt header points to a single table ('name'), and the 'name' table
 * contains a single record for the requested nameID.
 */
function makeTtfNameTable(
	names: Partial<Record<"family" | "fullName" | "postscriptName", string>>,
): Buffer {
	const records: { nameID: number; value: string }[] = [];
	if (names.family) records.push({ nameID: 1, value: names.family });
	if (names.fullName) records.push({ nameID: 4, value: names.fullName });
	if (names.postscriptName) records.push({ nameID: 6, value: names.postscriptName });

	// Encode each record as UTF-16BE
	const encoded = records.map((r) => {
		const buf = Buffer.alloc(r.value.length * 2);
		for (let i = 0; i < r.value.length; i++) {
			const code = r.value.charCodeAt(i);
			buf[i * 2] = (code >> 8) & 0xff;
			buf[i * 2 + 1] = code & 0xff;
		}
		return { nameID: r.nameID, buf };
	});

	// Name table: 6-byte header + 12 bytes per record + string storage
	const stringStorage = Buffer.concat(encoded.map((e) => e.buf));
	const nameTableSize = 6 + encoded.length * 12 + stringStorage.length;
	const nameTable = Buffer.alloc(nameTableSize);
	// format = 0
	nameTable.writeUInt16BE(0, 0);
	// count
	nameTable.writeUInt16BE(encoded.length, 2);
	// stringOffset (relative to start of name table)
	nameTable.writeUInt16BE(6 + encoded.length * 12, 4);
	// Records
	let strOff = 0;
	encoded.forEach((e, i) => {
		const recOff = 6 + i * 12;
		// platformID = 3 (Windows)
		nameTable.writeUInt16BE(3, recOff);
		// encodingID = 1 (Unicode BMP)
		nameTable.writeUInt16BE(1, recOff + 2);
		// languageID = 0x0409 (English US)
		nameTable.writeUInt16BE(0x0409, recOff + 4);
		// nameID
		nameTable.writeUInt16BE(e.nameID, recOff + 6);
		// length
		nameTable.writeUInt16BE(e.buf.length, recOff + 8);
		// offset
		nameTable.writeUInt16BE(strOff, recOff + 10);
		strOff += e.buf.length;
	});
	stringStorage.copy(nameTable, 6 + encoded.length * 12);

	// sfnt header: 12 bytes + 1 directory entry (16 bytes) = 28 bytes
	const headerSize = 12 + 16;
	const total = Buffer.alloc(headerSize + nameTable.length);
	// sfVersion = 0x00010000 (TrueType)
	total.writeUInt32BE(0x00010000, 0);
	// numTables = 1
	total.writeUInt16BE(1, 4);
	// searchRange, entrySelector, rangeShift — dummy values
	total.writeUInt16BE(16, 6);
	total.writeUInt16BE(0, 8);
	total.writeUInt16BE(0, 10);
	// Directory entry: 'name'
	total.write("name", 12, "ascii");
	// checksum — skip
	total.writeUInt32BE(0, 16);
	// offset
	total.writeUInt32BE(headerSize, 20);
	// length
	total.writeUInt32BE(nameTable.length, 24);
	nameTable.copy(total, headerSize);

	return total;
}

function writeFontFile(
	relPath: string,
	names: { family?: string; fullName?: string; postscriptName?: string },
): string {
	const buf = makeTtfNameTable(names);
	const full = path.join(testDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, buf);
	return full;
}

describe("fontResolver", () => {
	beforeEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	describe("readFontNames", () => {
		it("extracts family/full/postscript names from a TTF name table", () => {
			const p = writeFontFile("fonts/FiraSans-Regular.otf", {
				family: "Fira Sans",
				fullName: "Fira Sans Regular",
				postscriptName: "FiraSans-Regular",
			});
			const names = readFontNames(p);
			assert.strictEqual(names.family, "Fira Sans");
			assert.strictEqual(names.fullName, "Fira Sans Regular");
			assert.strictEqual(names.postscriptName, "FiraSans-Regular");
		});

		it("returns empty object for missing files", () => {
			const names = readFontNames(path.join(testDir, "nope.otf"));
			assert.deepStrictEqual(names, {});
		});

		it("returns empty object for files too small to be a font", () => {
			const p = path.join(testDir, "tiny.otf");
			fs.writeFileSync(p, Buffer.alloc(4));
			assert.deepStrictEqual(readFontNames(p), {});
		});
	});

	describe("buildFontIndex", () => {
		it("indexes workspace fonts by family name", () => {
			const root = path.join(testDir, "root");
			fs.mkdirSync(root, { recursive: true });
			writeFontFile("root/fonts/FiraSans-Regular.otf", {
				family: "Fira Sans",
				postscriptName: "FiraSans-Regular",
			});
			writeFontFile("root/fonts/FiraSans-Bold.otf", {
				family: "Fira Sans",
				postscriptName: "FiraSans-Bold",
			});
			const index = buildFontIndex([root], root);
			assert.strictEqual(index.size >= 2, true);
			assert.ok(index.get("fira sans"));
			assert.ok(index.get("firasans-regular"));
		});

		it("skips hidden directories and node_modules", () => {
			const root = path.join(testDir, "root");
			fs.mkdirSync(root, { recursive: true });
			writeFontFile("root/.git/secret.otf", { family: "Secret" });
			writeFontFile("root/node_modules/x.otf", { family: "NpmFont" });
			const index = buildFontIndex([root], root);
			assert.strictEqual(index.size, 0);
		});

		it("returns empty map for missing roots", () => {
			const index = buildFontIndex([], testDir);
			assert.strictEqual(index.size, 0);
		});

		it("records dirRelativeToRoot for fonts in subdirectories", () => {
			const root = path.join(testDir, "root");
			fs.mkdirSync(root, { recursive: true });
			writeFontFile("root/fonts/Arial.ttf", { family: "Arial" });
			const index = buildFontIndex([root], root);
			const e = index.get("arial");
			assert.ok(e);
			assert.strictEqual(e?.dirRelativeToRoot, "fonts");
			assert.strictEqual(e?.ext, ".ttf");
			assert.strictEqual(e?.stem, "Arial");
		});
	});

	describe("mergeFontIndices", () => {
		it("combines workspace and system entries", () => {
			const workspace = buildFontIndex([], testDir);
			workspace.set("firacode", {
				family: "Fira Code",
				filePath: "/proj/fonts/FiraCode-Regular.otf",
				stem: "FiraCode-Regular",
				ext: ".otf",
				dirRelativeToRoot: "fonts",
			});
			const system = new Map();
			system.set("arial", {
				family: "Arial",
				filePath: "C:\\Windows\\Fonts\\arial.ttf",
				stem: "arial",
				ext: ".ttf",
				dirRelativeToRoot: "",
			});
			const merged = mergeFontIndices(workspace, system);
			assert.strictEqual(merged.size, 2);
			assert.strictEqual(merged.get("firacode")?.family, "Fira Code");
			assert.strictEqual(merged.get("arial")?.family, "Arial");
		});

		it("workspace entry wins on family-name collision", () => {
			const workspace = new Map();
			workspace.set("arial", {
				family: "Arial",
				filePath: "/proj/fonts/Arial.ttf",
				stem: "Arial",
				ext: ".ttf",
				dirRelativeToRoot: "fonts",
			});
			const system = new Map();
			system.set("arial", {
				family: "Arial",
				filePath: "C:\\Windows\\Fonts\\arial.ttf",
				stem: "arial",
				ext: ".ttf",
				dirRelativeToRoot: "",
			});
			const merged = mergeFontIndices(workspace, system);
			assert.strictEqual(merged.size, 1);
			assert.strictEqual(merged.get("arial")?.filePath, "/proj/fonts/Arial.ttf");
		});

		it("empty inputs return empty map", () => {
			const merged = mergeFontIndices(new Map(), new Map());
			assert.strictEqual(merged.size, 0);
		});
	});

	describe("extractMacroDefinitions", () => {
		it("extracts \\def-style definitions with spaces", () => {
			const macros = extractMacroDefinitions("\\def \\fontType {Arial}");
			assert.strictEqual(macros.get("fontType"), "Arial");
		});

		it("extracts \\def-style definitions without spaces", () => {
			const macros = extractMacroDefinitions("\\def\\fontType{Arial}");
			assert.strictEqual(macros.get("fontType"), "Arial");
		});

		it("extracts \\newcommand with unbraced name", () => {
			const macros = extractMacroDefinitions("\\newcommand\\fontType{Fira Sans}");
			assert.strictEqual(macros.get("fontType"), "Fira Sans");
		});

		it("extracts \\newcommand with braced name and star", () => {
			const macros = extractMacroDefinitions("\\providecommand*{\\fontType}{Arial}");
			assert.strictEqual(macros.get("fontType"), "Arial");
		});

		it("later definitions win", () => {
			const macros = extractMacroDefinitions(
				"\\def\\fontType{Arial}\n\\renewcommand\\fontType{Fira Sans}",
			);
			assert.strictEqual(macros.get("fontType"), "Fira Sans");
		});

		it("skips parameterized macros", () => {
			const macros = extractMacroDefinitions("\\newcommand\\foo[1]{#1}");
			assert.strictEqual(macros.size, 0);
		});

		it("returns empty map for no definitions", () => {
			assert.strictEqual(extractMacroDefinitions("\\setmainfont{Arial}").size, 0);
		});
	});

	describe("resolveFontReferences", () => {
		function makeIndex(entries: Array<{ family: string; stem: string; ext: string; dir?: string }>) {
			const m = new Map<string, ReturnType<typeof buildFontIndex> extends Map<string, infer V> ? V : never>();
			for (const e of entries) {
				const v = {
					family: e.family,
					filePath: "",
					stem: e.stem,
					ext: e.ext,
					dirRelativeToRoot: e.dir ?? "",
				} as any;
				m.set(e.family.toLowerCase(), v);
			}
			return m;
		}

		it("rewrites \\setmainfont{Family} to filename with Path= + Extension=", () => {
			const index = makeIndex([{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf", dir: "fonts" }]);
			const src = "\\setmainfont{Fira Sans}";
			const r = resolveFontReferences(src, index, {}, testDir);
			assert.strictEqual(
				r.source,
				"\\setmainfont[Path=fonts/,Extension=.otf]{FiraSans-Regular}",
			);
			assert.strictEqual(r.rewritten.length, 1);
			assert.strictEqual(r.unresolved.length, 0);
		});

		it("rewrites root-level font with Path=./ + Extension= so fontspec resolves via filename", () => {
			const index = makeIndex([{ family: "Arial", stem: "Arial", ext: ".ttf" }]);
			const r = resolveFontReferences("\\setmainfont{Arial}", index, {}, testDir);
			assert.strictEqual(r.source, "\\setmainfont[Path=./,Extension=.ttf]{Arial}");
		});

		it("leaves existing filenames untouched", () => {
			const r = resolveFontReferences(
				"\\setmainfont{FiraSans-Regular.otf}",
				new Map(),
				{},
				testDir,
			);
			assert.strictEqual(r.source, "\\setmainfont{FiraSans-Regular.otf}");
			assert.strictEqual(r.rewritten.length, 0);
			assert.strictEqual(r.unresolved.length, 0);
		});

		it("rewrites \\setsansfont, \\setmonofont, \\setmathfont, \\newfontfamily", () => {
			const index = makeIndex([
				{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf" },
				{ family: "Fira Code", stem: "FiraCode-Regular", ext: ".otf" },
			]);
			const src = [
				"\\setsansfont{Fira Sans}",
				"\\setmonofont{Fira Code}",
				"\\setmathfont{Fira Sans}",
				"\\newfontfamily\\myfont{Fira Sans}",
			].join("\n");
			const r = resolveFontReferences(src, index, {}, testDir);
			assert.ok(r.source.includes("\\setsansfont[Path=./,Extension=.otf]{FiraSans-Regular}"));
			assert.ok(r.source.includes("\\setmonofont[Path=./,Extension=.otf]{FiraCode-Regular}"));
			assert.ok(r.source.includes("\\setmathfont[Path=./,Extension=.otf]{FiraSans-Regular}"));
			assert.ok(r.source.includes("\\newfontfamily[Path=./,Extension=.otf]\\myfont{FiraSans-Regular}"));
			assert.strictEqual(r.rewritten.length, 4);
		});

		it("uses aliases when the name is not in the index", () => {
			const r = resolveFontReferences(
				"\\setmainfont{Latin Modern Roman}",
				new Map(),
				{ "Latin Modern Roman": "fonts/lmroman12-regular.otf" },
				testDir,
			);
			assert.ok(r.source.includes("Path=fonts/"));
			assert.ok(r.source.includes("Extension=.otf"));
			assert.ok(r.source.includes("{lmroman12-regular}"));
		});

		it("aliases take precedence over the auto-built index", () => {
			const index = makeIndex([{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf" }]);
			const r = resolveFontReferences(
				"\\setmainfont{Fira Sans}",
				index,
				{ "Fira Sans": "different/FiraSans.otf" },
				testDir,
			);
			assert.ok(r.source.includes("Path=different/"));
			assert.ok(r.source.includes("{FiraSans}"));
		});

		it("reports unresolved references with line numbers", () => {
			const r = resolveFontReferences(
				"\\setmainfont{Not Installed}\n\\setmonofont{Also Missing}",
				new Map(),
				{},
				testDir,
			);
			assert.strictEqual(r.unresolved.length, 2);
			assert.strictEqual(r.unresolved[0].line, 1);
			assert.strictEqual(r.unresolved[0].name, "Not Installed");
			assert.strictEqual(r.unresolved[1].line, 2);
			assert.strictEqual(r.unresolved[1].name, "Also Missing");
		});

		it("preserves existing option keys when adding Path/Extension", () => {
			const index = makeIndex([{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf", dir: "fonts" }]);
			const r = resolveFontReferences(
				"\\setmainfont[Scale=1.2]{Fira Sans}",
				index,
				{},
				testDir,
			);
			assert.ok(r.source.includes("Scale=1.2"));
			assert.ok(r.source.includes("Path=fonts/"));
		});

		it("does not override user-supplied Path/Extension", () => {
			const index = makeIndex([{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf", dir: "fonts" }]);
			const r = resolveFontReferences(
				"\\setmainfont[Path=user/,Extension=.otf]{Fira Sans}",
				index,
				{},
				testDir,
			);
			assert.ok(r.source.includes("Path=user/"));
			assert.ok(!r.source.includes("Path=fonts/"));
		});

		it("rewrites UprightFont/BoldFont options", () => {
			const index = makeIndex([
				{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf", dir: "fonts" },
				{ family: "Fira Sans Bold", stem: "FiraSans-Bold", ext: ".otf", dir: "fonts" },
			]);
			const r = resolveFontReferences(
				"\\setmainfont[UprightFont={Fira Sans},BoldFont={Fira Sans Bold}]{Fira Sans}",
				index,
				{},
				testDir,
			);
			assert.ok(r.source.includes("UprightFont={FiraSans-Regular}"));
			assert.ok(r.source.includes("BoldFont={FiraSans-Bold}"));
		});

		it("case-insensitive lookup", () => {
			const index = makeIndex([{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf" }]);
			const r = resolveFontReferences(
				"\\setmainfont{fira sans}",
				index,
				{},
				testDir,
			);
			assert.ok(r.source.includes("{FiraSans-Regular}"));
		});

		it("rewrites a full lualatex-style document via the merged workspace+system index", () => {
			// The system font index, when populated by getOrBuildSystemFontIndex,
			// is just another Map<lowercasedFamily, FontIndexEntry>. The rewriter
			// doesn't care which side of the merge the entry came from — the
			// rewrite contract is the same: family name in, stem out.
			const src = [
				"% !TEX program = lualatex",
				"\\documentclass{article}",
				"\\usepackage{fontspec}",
				"\\setmainfont{Arial}",
				"",
				"\\begin{document}",
				"Hello, World!",
				"\\end{document}",
			].join("\n");
			const merged = new Map();
			merged.set("arial", {
				family: "Arial",
				filePath: "C:\\Windows\\Fonts\\arial.ttf",
				stem: "arial",
				ext: ".ttf",
				dirRelativeToRoot: "",
			});
			const r = resolveFontReferences(src, merged, {}, testDir);
			assert.ok(
				r.source.includes("\\setmainfont[Path=./,Extension=.ttf]{arial}"),
				`expected rewrite to \\setmainfont[Path=./,Extension=.ttf]{arial} but got:\n${r.source}`,
			);
			assert.strictEqual(r.rewritten.length, 1);
			assert.strictEqual(r.rewritten[0].from, "Arial");
			assert.strictEqual(r.rewritten[0].to, "arial");
			assert.strictEqual(r.unresolved.length, 0);
		});

		it("resolves a font name stored in a macro defined in the same source", () => {
			const index = makeIndex([{ family: "Arial", stem: "Arial", ext: ".ttf" }]);
			const src = [
				"\\def \\fontType {Arial}",
				"\\setmainfont{\\fontType}",
			].join("\n");
			const r = resolveFontReferences(src, index, {}, testDir);
			assert.ok(
				r.source.includes("\\setmainfont[Path=./,Extension=.ttf]{Arial}"),
				`expected rewritten setmainfont but got:\n${r.source}`,
			);
			assert.strictEqual(r.rewritten.length, 1);
			assert.strictEqual(r.rewritten[0].from, "Arial");
			assert.strictEqual(r.unresolved.length, 0);
		});

		it("resolves a font name stored in a macro passed from another file", () => {
			// \fontType is defined in an included file (extractMacroDefinitions),
			// \setmainfont uses it in the root — both files must be resolved together.
			const index = makeIndex([{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf", dir: "fonts" }]);
			const macros = extractMacroDefinitions("\\newcommand{\\fontType}{Fira Sans}");
			const r = resolveFontReferences(
				"\\setmainfont{\\fontType}",
				index,
				{},
				testDir,
				macros,
			);
			assert.ok(
				r.source.includes("\\setmainfont[Path=fonts/,Extension=.otf]{FiraSans-Regular}"),
				`expected cross-file rewrite but got:\n${r.source}`,
			);
			assert.strictEqual(r.rewritten.length, 1);
			assert.strictEqual(r.unresolved.length, 0);
		});

		it("resolves chained macro definitions", () => {
			const index = makeIndex([{ family: "Arial", stem: "arial", ext: ".ttf" }]);
			const macros = extractMacroDefinitions(
				"\\def\\family{Arial}\n\\def\\fontType{\\family}",
			);
			const r = resolveFontReferences(
				"\\setmainfont{\\fontType}",
				index,
				{},
				testDir,
				macros,
			);
			assert.ok(r.source.includes("{arial}"));
			assert.strictEqual(r.rewritten.length, 1);
		});

		it("reports an undefined macro as unresolved", () => {
			const r = resolveFontReferences(
				"\\setmainfont{\\fontType}",
				new Map(),
				{},
				testDir,
			);
			assert.strictEqual(r.rewritten.length, 0);
			assert.strictEqual(r.unresolved.length, 1);
			assert.strictEqual(r.unresolved[0].name, "\\fontType");
		});

		it("reports a macro whose value is an unknown font as unresolved", () => {
			const macros = extractMacroDefinitions("\\def\\fontType{Not Installed}");
			const r = resolveFontReferences(
				"\\setmainfont{\\fontType}",
				new Map(),
				{},
				testDir,
				macros,
			);
			assert.strictEqual(r.unresolved.length, 1);
			assert.strictEqual(r.unresolved[0].name, "Not Installed");
		});

		it("resolves font option values stored in macros", () => {
			const index = makeIndex([
				{ family: "Fira Sans", stem: "FiraSans-Regular", ext: ".otf", dir: "fonts" },
			]);
			const macros = extractMacroDefinitions("\\def\\myUpright{Fira Sans}");
			const r = resolveFontReferences(
				"\\setmainfont[UprightFont={\\myUpright}]{Fira Sans}",
				index,
				{},
				testDir,
				macros,
			);
			assert.ok(r.source.includes("UprightFont={FiraSans-Regular}"));
		});
	});
});

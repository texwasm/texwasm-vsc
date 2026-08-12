import { describe, it } from "mocha";
import assert from "node:assert";
import {
	makeSyntheticIns,
	parseInstallDriver,
} from "../../src/cache/packageCache";

const PDFLSCAPE_DTX = `\\
\\NeedsTeXFormat{LaTeX2e}
\\ProvidesFile{pdflscape.dtx}
%<*ignore>
ignore me
%</ignore>
%<*install>
\\input docstrip.tex
\\keepsilent
\\askforoverwritefalse
\\generate{%
  \\file{pdflscape.ins}{\\from{pdflscape.dtx}{install}}%
  \\file{pdflscape.drv}{\\from{pdflscape.dtx}{driver}}%
  \\usedir{tex/latex/pdflscape}%
  \\file{pdflscape-nometadata.sty}{\\from{pdflscape.dtx}{package}}%
  \\file{pdflscape.sty}{\\from{pdflscape.dtx}{package-new}}%
}
\\endbatchfile
%</install>
%<*ignore>
%</ignore>
%<*package>
\\ProvidesPackage{pdflscape-nometadata}
%</package>
%<*package-new>
\\ProvidesExplPackage{pdflscape}{2025-06-23}{0.14}
%</package-new>
`;

describe("parseInstallDriver", () => {
	it("extracts \\file mappings from the install section", () => {
		const mappings = parseInstallDriver(PDFLSCAPE_DTX, "pdflscape.dtx");
		assert.ok(mappings, "expected mappings");
		assert.deepStrictEqual(mappings, [
			{ fileName: "pdflscape-nometadata.sty", guards: ["package"] },
			{ fileName: "pdflscape.sty", guards: ["package-new"] },
		]);
	});

	it("skips .ins/.drv outputs and foreign dtx bases", () => {
		const mappings = parseInstallDriver(PDFLSCAPE_DTX, "pdflscape.dtx");
		assert.ok(mappings);
		assert.ok(
			mappings.every((m) => !m.fileName.endsWith(".ins") && !m.fileName.endsWith(".drv")),
		);
	});

	it("returns null when no install section exists", () => {
		const noInstall = "%<*package>\n\\ProvidesPackage{foo}\n%</package>\n";
		assert.strictEqual(parseInstallDriver(noInstall, "foo.dtx"), null);
	});
});

describe("makeSyntheticIns", () => {
	it("reproduces the install driver's multi-file mapping for pdflscape", () => {
		const ins = makeSyntheticIns("pdflscape.dtx", "pdflscape", PDFLSCAPE_DTX);
		assert.ok(ins.includes("\\file{pdflscape-nometadata.sty}{\\from{pdflscape.dtx}{package}}"));
		assert.ok(ins.includes("\\file{pdflscape.sty}{\\from{pdflscape.dtx}{package-new}}"));
		assert.ok(!ins.includes("{install}"));
		assert.ok(!ins.includes("{driver}"));
	});

	it("falls back to a single {pkg}.sty when no install driver is present", () => {
		const dtx =
			"%<*package>\n\\ProvidesPackage{foo}\n%</package>\n%<*package-new>\n\\ProvidesExplPackage{foo}\n%</package-new>\n";
		const ins = makeSyntheticIns("foo.dtx", "foo", dtx);
		assert.ok(ins.includes("\\file{foo.sty}{\\from{foo.dtx}{package-new,package}}"));
	});
});

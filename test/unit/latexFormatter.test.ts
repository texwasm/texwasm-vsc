import { describe, it } from 'mocha';
import assert from 'node:assert';
import { formatLatex } from '../../src/utils/latexFormatter';

const INDENT = '  ';

describe('formatLatex', () => {
  it('indents the contents of an environment', () => {
    const src = '\\begin{document}\nHello world.\n\\end{document}';
    const expected =
      '\\begin{document}\n  Hello world.\n\\end{document}';
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('indents nested environments', () => {
    const src = [
      '\\begin{itemize}',
      '\\item one',
      '\\begin{itemize}',
      '\\item nested',
      '\\end{itemize}',
      '\\item two',
      '\\end{itemize}',
    ].join('\n');
    const expected = [
      '\\begin{itemize}',
      '  \\item one',
      '  \\begin{itemize}',
      '    \\item nested',
      '  \\end{itemize}',
      '  \\item two',
      '\\end{itemize}',
    ].join('\n');
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('does not indent a balanced begin/end on one line', () => {
    const src = '\\begin{document}\n\\begin{center}centered\\end{center}\n\\end{document}';
    const expected =
      '\\begin{document}\n  \\begin{center}centered\\end{center}\n\\end{document}';
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('leaves preamble at the top level', () => {
    const src = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\begin{document}',
      'Text.',
      '\\end{document}',
    ].join('\n');
    const expected = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\begin{document}',
      '  Text.',
      '\\end{document}',
    ].join('\n');
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('preserves verbatim bodies byte-for-byte', () => {
    const src = [
      '\\begin{document}',
      '\\begin{verbatim}',
      '  int x = 1;',
      '  if (x) { return; }',
      '\\end{verbatim}',
      '\\end{document}',
    ].join('\n');
    const expected = [
      '\\begin{document}',
      '  \\begin{verbatim}',
      '  int x = 1;',
      '  if (x) { return; }',
      '  \\end{verbatim}',
      '\\end{document}',
    ].join('\n');
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('preserves lstlisting and minted bodies', () => {
    const src = [
      '\\begin{lstlisting}',
      'class Foo {',
      '}',
      '\\end{lstlisting}',
      '\\begin{minted}{python}',
      '  print("hi")',
      '\\end{minted}',
    ].join('\n');
    assert.strictEqual(formatLatex(src, INDENT), src);
  });

  it('trims leading and trailing whitespace', () => {
    const src = '\\begin{document}\n    spaced text    \n\\end{document}';
    const expected =
      '\\begin{document}\n  spaced text\n\\end{document}';
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('preserves blank lines and indents comments', () => {
    const src = [
      '\\begin{document}',
      '\\section{Intro}',
      '',
      '% a comment',
      '\\begin{itemize}',
      '\\item x',
      '\\end{itemize}',
      '\\end{document}',
    ].join('\n');
    const expected = [
      '\\begin{document}',
      '  \\section{Intro}',
      '',
      '  % a comment',
      '  \\begin{itemize}',
      '    \\item x',
      '  \\end{itemize}',
      '\\end{document}',
    ].join('\n');
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('does not let depth go negative on stray \\end', () => {
    const src = '\\end{itemize}\n\\begin{itemize}\n\\item x\n\\end{itemize}';
    const expected =
      '\\end{itemize}\n\\begin{itemize}\n  \\item x\n\\end{itemize}';
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('keeps CRLF line endings', () => {
    const src = '\\begin{document}\r\nHello.\r\n\\end{document}';
    const expected = '\\begin{document}\r\n  Hello.\r\n\\end{document}';
    assert.strictEqual(formatLatex(src, INDENT), expected);
  });

  it('supports tab indentation', () => {
    const src = '\\begin{document}\nHello.\n\\end{document}';
    const expected = '\\begin{document}\n\tHello.\n\\end{document}';
    assert.strictEqual(formatLatex(src, '\t'), expected);
  });
});

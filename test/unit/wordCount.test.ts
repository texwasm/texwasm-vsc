import { describe, it } from 'mocha';
import assert from 'node:assert';
import { countWordsInSource } from '../../src/utils/wordCount';

describe('countWordsInSource', () => {
  it('counts words in body text', () => {
    const src = `\\documentclass{article}
\\begin{document}
Hello world. This is a test.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 6);
    assert.strictEqual(result.totalWords, 6);
    assert.strictEqual(result.headerWords, 0);
    assert.strictEqual(result.captionWords, 0);
    assert.strictEqual(result.footnoteWords, 0);
  });

  it('ignores the preamble', () => {
    const src = `\\documentclass{article}
\\usepackage{amsmath}
\\title{Preamble Title That Should Not Count}
\\begin{document}
Body words.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 2);
  });

  it('counts words in section headers separately', () => {
    const src = `\\begin{document}
\\section{Introduction}
Hello.
\\subsection*{Motivation}
More text.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 3);
    assert.strictEqual(result.headerWords, 2);
    assert.strictEqual(result.headers, 2);
  });

  it('counts words in captions and figure/table environments', () => {
    const src = `\\begin{document}
\\begin{figure}
\\includegraphics{plot}
\\caption{A sample figure.}
\\end{figure}
\\begin{table}
\\caption{Results overview.}
\\end{table}
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.captionWords, 5);
    assert.strictEqual(result.figures, 1);
    assert.strictEqual(result.tables, 1);
    assert.strictEqual(result.textWords, 0);
  });

  it('counts words in footnotes separately', () => {
    const src = `\\begin{document}
Some text.\\footnote{An interesting footnote.}
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.footnoteWords, 3);
    assert.strictEqual(result.textWords, 2);
  });

  it('counts inline math but not display math', () => {
    const src = `\\begin{document}
Inline $x^2$ and $y$ here.
\\[ a + b \\]
\\begin{equation}
e = mc^2
\\end{equation}
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.mathInlines, 2);
    assert.strictEqual(result.textWords, 3);
  });

  it('ignores comments', () => {
    const src = `\\begin{document}
Hello % this is a comment with words
world.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 2);
  });

  it('ignores verbatim environments', () => {
    const src = `\\begin{document}
Before.
\\begin{verbatim}
a lot of words should not count
% not even comments inside
\\end{verbatim}
After.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 2);
  });

  it('ignores citations, refs and includegraphics arguments', () => {
    const src = `\\begin{document}
See \\cite{smith2020} and \\ref{fig:plot}.
\\begin{figure}
\\includegraphics[width=0.5\\textwidth]{image-file}
\\caption{Figure caption.}
\\end{figure}
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 2);
    assert.strictEqual(result.captionWords, 2);
  });

  it('counts a file without a document environment in full', () => {
    const src = `Some standalone text.
\\section{Header here}
More words.`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 5);
    assert.strictEqual(result.headerWords, 2);
    assert.strictEqual(result.headers, 1);
  });

  it('handles section optional arguments', () => {
    const src = `\\begin{document}
\\section[Short]{The Full Long Header}
Body.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.headerWords, 4);
  });

  it('counts escaped percent signs as text', () => {
    const src = `\\begin{document}
50\\% complete. Done.
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 2);
  });

  it('sums totalWords across categories', () => {
    const src = `\\begin{document}
Text words.
\\section{Header words}
\\begin{figure}
\\caption{Caption words}
\\end{figure}
\\footnote{Footnote words}
\\end{document}`;
    const result = countWordsInSource(src);
    assert.strictEqual(result.textWords, 2);
    assert.strictEqual(result.headerWords, 2);
    assert.strictEqual(result.captionWords, 2);
    assert.strictEqual(result.footnoteWords, 2);
    assert.strictEqual(result.totalWords, 8);
  });
});

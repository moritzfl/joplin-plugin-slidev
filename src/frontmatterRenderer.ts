// Markdown-it content script: hides YAML frontmatter from Joplin's note
// viewer.  Matches both the document-level frontmatter at the top and
// per-slide frontmatter anywhere in the note.
//
// Mirrors Slidev's parser frontmatter split:
//   - A line that starts with --- is a slide separator.
//   - It becomes frontmatter when the fourth character is not - and the next
//     line is non-empty. This includes named separators such as ---section2.
//   - Scan until a closing line whose trimEnd() is exactly ---; blank lines
//     inside the body are fine.

export default function (_context: unknown) {
	return {
		plugin: function (md: any) {
			md.block.ruler.before(
				'hr',
				'slidev_frontmatter',
				function (
					state: any,
					startLine: number,
					endLine: number,
					silent: boolean,
				) {
					// Keep this in sync with Slidev's packages/parser/src/core.ts.
					const openPos = state.bMarks[startLine];
					const openEnd = state.eMarks[startLine];
					const openLine = state.src.slice(openPos, openEnd).trimEnd();
					if (!openLine.startsWith('---') || openLine[3] === '-') return false;

					const bodyStart = startLine + 1;
					if (bodyStart >= endLine) return false;

					// The line immediately after the separator must be non-empty.
					if (state.src.slice(state.bMarks[bodyStart], state.eMarks[bodyStart]).trim() === '') return false;

					// Scan for the closing ---; blank lines within are fine.
					let closingLine = -1;
					for (let i = bodyStart; i < endLine; i++) {
						if (state.src.slice(state.bMarks[i], state.eMarks[i]).trimEnd() === '---') {
							closingLine = i;
							break;
						}
					}
					if (closingLine < 0) return false;
					if (silent) return true;

					const token = state.push('slidev_frontmatter', '', 0);
					token.map = [startLine, closingLine + 1];
					token.block = true;

					state.line = closingLine + 1;
					return true;
				},
				{ alt: [] },
			);

			md.renderer.rules['slidev_frontmatter'] = () => '';
		},
	};
}

// Markdown-it content script: hides YAML frontmatter from Joplin's note
// viewer.  Matches both the document-level frontmatter at the top and
// per-slide frontmatter anywhere in the note.
//
// Detection rule (Slidev spec):
//   - Line is exactly ---
//   - The very next line must be non-empty.
//     A blank line after --- is explicitly "risky" per the Slidev spec and
//     the preferred style has content start immediately on the next line.
//     This also distinguishes a frontmatter block from a plain --- slide
//     separator.
//   - Scan until the next --- line; blank lines *within* the body are fine.
//   - A line that is exactly --- closes the block.

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
					// Opening line must be exactly ---.
					const openPos = state.bMarks[startLine] + state.tShift[startLine];
					const openEnd = state.eMarks[startLine];
					if (state.src.slice(openPos, openEnd).trim() !== '---') return false;

					const bodyStart = startLine + 1;
					if (bodyStart >= endLine) return false;

					// The line immediately after --- must be non-empty.
					if (state.src.slice(state.bMarks[bodyStart], state.eMarks[bodyStart]).trim() === '') return false;

					// Scan for the closing ---; blank lines within are fine.
					let closingLine = -1;
					for (let i = bodyStart; i < endLine; i++) {
						if (state.src.slice(state.bMarks[i], state.eMarks[i]).trim() === '---') {
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

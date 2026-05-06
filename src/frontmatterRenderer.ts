// Markdown-it content script: hides YAML frontmatter from Joplin's note
// viewer.  Matches both the document-level frontmatter at the top and
// per-slide frontmatter anywhere in the note.

import { isSlidevMatterClosingLine, isSlidevMatterOpeningLine } from './slidevMatter';

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
					const openPos = state.bMarks[startLine];
					const openEnd = state.eMarks[startLine];
					const openLine = state.src.slice(openPos, openEnd).trimEnd();

					const bodyStart = startLine + 1;
					if (bodyStart >= endLine) return false;

					const firstBodyLine = state.src.slice(state.bMarks[bodyStart], state.eMarks[bodyStart]);
					if (!isSlidevMatterOpeningLine(openLine, firstBodyLine)) return false;

					let closingLine = -1;
					for (let i = bodyStart; i < endLine; i++) {
						if (isSlidevMatterClosingLine(state.src.slice(state.bMarks[i], state.eMarks[i]))) {
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

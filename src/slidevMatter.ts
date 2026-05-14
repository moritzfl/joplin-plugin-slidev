export type SlidevMatterStyle = 'frontmatter' | 'yaml';

// Mirrors Slidev's parser matter split in packages/parser/src/core.ts.
export interface SlidevMatterBlock {
	style: SlidevMatterStyle;
	opener: string;
	raw: string;
	body: string;
}

export interface ParsedSlidevMatter extends SlidevMatterBlock {
	data: Record<string, any>;
}

const MATTER_RE = /^(---[^\r\n]*\r?\n)([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
const YAML_CODEBLOCK_MATTER_RE = /^(\s*```ya?ml)([\s\S]*?)```(?:\r?\n|$)/;

export const isSlidevMatterOpeningLine = (line: string, nextLine: string | undefined): boolean =>
	line.startsWith('---') && line[3] !== '-' && Boolean(nextLine?.trim());

export const isSlidevMatterClosingLine = (line: string): boolean =>
	line.trimEnd() === '---';

export const findSlidevMatterBlock = (markdown: string): SlidevMatterBlock | null => {
	const match = markdown.match(MATTER_RE);
	if (match && match.index === 0) {
		const opener = match[1].trimEnd();
		const firstBodyLine = match[2].split(/\r?\n/, 1)[0] ?? '';
		if (isSlidevMatterOpeningLine(opener, firstBodyLine)) {
			return {
				style: 'frontmatter',
				opener,
				raw: match[2],
				body: markdown.slice(match[0].length),
			};
		}
	}

	const yamlCodeblockMatch = markdown.match(YAML_CODEBLOCK_MATTER_RE);
	if (!yamlCodeblockMatch) return null;
	return {
		style: 'yaml',
		opener: yamlCodeblockMatch[1],
		raw: yamlCodeblockMatch[2],
		body: markdown.slice(yamlCodeblockMatch[0].length),
	};
};

export const parseSlidevMatter = (
	markdown: string,
	parseData: (raw: string) => Record<string, any> | null,
): ParsedSlidevMatter | null => {
	const block = findSlidevMatterBlock(markdown);
	if (!block) return null;
	const data = parseData(block.raw);
	return data ? { ...block, data } : null;
};

export const serializeSlidevMatter = (
	fm: Pick<ParsedSlidevMatter, 'style' | 'opener' | 'data' | 'body'>,
	dumpData: (data: Record<string, any>) => string,
): string => {
	const yaml = dumpData(fm.data);
	if (fm.style === 'yaml') return `${fm.opener}\n${yaml}\n\`\`\`\n${fm.body}`;
	return `${fm.opener}\n${yaml}\n---\n${fm.body}`;
};

export const updateSlidevMatter = (
	markdown: string,
	parseData: (raw: string) => Record<string, any> | null,
	dumpData: (data: Record<string, any>) => string,
	updateData: (data: Record<string, any>, hasMatter: boolean) => boolean,
): string => {
	const fm = parseSlidevMatter(markdown, parseData);
	if (fm) {
		return updateData(fm.data, true)
			? serializeSlidevMatter(fm, dumpData)
			: markdown;
	}

	const data: Record<string, any> = {};
	if (!updateData(data, false)) return markdown;
	return `---\n${dumpData(data)}\n---\n\n${markdown}`;
};

import { describe, expect, it } from 'vitest';
import {
	findSlidevMatterBlock,
	isSlidevMatterClosingLine,
	isSlidevMatterOpeningLine,
	updateSlidevMatter,
} from '../src/slidevMatter';

const parseData = (raw: string): Record<string, any> | null => {
	const data: Record<string, any> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(/^([^:#]+):\s*(.*)$/);
		if (match) data[match[1].trim()] = match[2].trim();
	}
	return data;
};

const dumpData = (data: Record<string, any>) =>
	Object.entries(data).map(([key, value]) => `${key}: ${value}`).join('\n');

describe('slidevMatter', () => {
	it('matches Slidev frontmatter opening and closing line rules', () => {
		expect(isSlidevMatterOpeningLine('---', 'layout: cover')).toBe(true);
		expect(isSlidevMatterOpeningLine('---section2', 'layout: cover')).toBe(true);
		expect(isSlidevMatterOpeningLine('----', 'layout: cover')).toBe(false);
		expect(isSlidevMatterOpeningLine('---', '')).toBe(false);
		expect(isSlidevMatterClosingLine('---   ')).toBe(true);
		expect(isSlidevMatterClosingLine('  ---')).toBe(false);
	});

	it('finds traditional frontmatter blocks', () => {
		expect(findSlidevMatterBlock('---\nlayout: cover\n---\n# Slide')).toEqual({
			style: 'frontmatter',
			opener: '---',
			raw: 'layout: cover\n',
			body: '# Slide',
		});
	});

	it('handles named separators and rejects non-frontmatter separators', () => {
		expect(findSlidevMatterBlock('---section2\nlayout: cover\n---\n# Slide')?.opener).toBe('---section2');
		expect(findSlidevMatterBlock('----\nlayout: cover\n----\n# Slide')).toBeNull();
		expect(findSlidevMatterBlock('---\n\n# Slide\n---')).toBeNull();
	});

	it('ignores per-slide matter blocks when updating document defaults', () => {
		const markdown = '# Intro\n\n---\nlayout: two-cols\n---\n# Details';

		expect(updateSlidevMatter(markdown, parseData, dumpData, (data, hasMatter) => {
			expect(hasMatter).toBe(false);
			data.editor = false;
			return true;
		})).toBe('---\neditor: false\n---\n\n# Intro\n\n---\nlayout: two-cols\n---\n# Details');
	});

	it('finds leading yaml codeblock matter', () => {
		expect(findSlidevMatterBlock('```yaml\nlayout: cover\n```\n# Slide')).toEqual({
			style: 'yaml',
			opener: '```yaml',
			raw: '\nlayout: cover\n',
			body: '# Slide',
		});
	});

	it('updates existing matter blocks', () => {
		expect(updateSlidevMatter('---\nlayout: cover\n---\n# Slide', parseData, dumpData, (data, hasMatter) => {
			expect(hasMatter).toBe(true);
			data.editor = false;
			return true;
		})).toBe('---\nlayout: cover\neditor: false\n---\n# Slide');
	});

	it('creates matter blocks when absent', () => {
		expect(updateSlidevMatter('# Slide', parseData, dumpData, (data, hasMatter) => {
			expect(hasMatter).toBe(false);
			data.editor = false;
			return true;
		})).toBe('---\neditor: false\n---\n\n# Slide');
	});
});

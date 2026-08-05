import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import frontmatterRenderer from '../src/frontmatterRenderer';

const render = (markdown: string) => {
	const parser = new MarkdownIt();
	frontmatterRenderer({}).plugin(parser);
	return parser.render(markdown);
};

describe('frontmatterRenderer', () => {
	it('preserves ordinary Slidev separators without surrounding blank lines', () => {
		const html = render('# One\n---\n# Two\n---\n# Three\n');

		expect(html).toContain('<h1>One</h1>');
		expect(html).toContain('<h1>Two</h1>');
		expect(html).toContain('<h1>Three</h1>');
	});

	it('hides document and per-slide YAML mappings', () => {
		const html = render('---\ntheme: seriph\n---\n# One\n---\nlayout: center\n---\n# Two\n');

		expect(html).not.toContain('theme: seriph');
		expect(html).not.toContain('layout: center');
		expect(html).toContain('<h1>One</h1>');
		expect(html).toContain('<h1>Two</h1>');
	});
});

import { readFile } from 'fs/promises';
import { join } from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/slidevExtraFiles/styles-index.css', () => ({ default: '' }));
vi.mock('../src/slidevExtraFiles/styles-presenter.css', () => ({ default: '' }));
vi.mock('../src/slidevExtraFiles/global-top.vue', () => ({ default: '' }));
vi.mock('../src/slidevExtraFiles/global-bottom.vue', () => ({ default: '' }));

let buildSlidevExtraFiles: typeof import('../src/slidevExtraFiles').buildSlidevExtraFiles;

beforeAll(async () => {
	({ buildSlidevExtraFiles } = await import('../src/slidevExtraFiles'));
});

describe('buildSlidevExtraFiles', () => {
	it('adds a Vite resolver for Slidev virtual-module resource imports', () => {
		const files = buildSlidevExtraFiles({ remoteTunnel: false, presenterControlledNavigation: false });

		expect(files['vite.config.mjs']).toContain('joplin-slidev-resource-resolver');
		expect(files['vite.config.mjs']).toContain("source.startsWith('./resources/')");
		expect(files['vite.config.mjs']).toContain("source.startsWith('resources/')");
		expect(files['vite.config.mjs']).toContain("importer?.includes('slides.md__slidev_')");
		expect(files['vite.config.mjs']).toContain("relativeTarget.startsWith('..' + sep)");
		expect(files['vite.config.mjs']).toContain("new URL('./resources/', import.meta.url)");
		expect(files['vite.config.mjs']).toContain("if (!resolved) throw new Error");
		expect(files['vite.config.mjs']).not.toContain('return resolve(__dirname, source');
		expect(files['vite.config.mjs']).not.toContain("source.startsWith('/resources/");
	});

	it('keeps the tunnel host allow-list when generating vite config', () => {
		const files = buildSlidevExtraFiles({ remoteTunnel: true, presenterControlledNavigation: false });

		expect(files['vite.config.mjs']).toContain("allowedHosts: ['trycloudflare.com', '.trycloudflare.com']");
	});

	it('uses the injected Slidev navigation state without importing transitive router packages', async () => {
		const source = await readFile(join(process.cwd(), 'src', 'slidevExtraFiles', 'global-bottom.vue'), 'utf-8');

		expect(source).toContain('slidevCtx.nav.currentPage.value');
		expect(source).not.toContain("from 'vue-router'");
	});
});

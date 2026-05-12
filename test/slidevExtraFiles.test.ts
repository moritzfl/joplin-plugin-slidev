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

		expect(files['vite.config.ts']).toContain('joplin-slidev-resource-resolver');
		expect(files['vite.config.ts']).toContain("source.startsWith('./resources/')");
		expect(files['vite.config.ts']).toContain("source.startsWith('resources/')");
		expect(files['vite.config.ts']).toContain("importer?.includes('slides.md__slidev_')");
		expect(files['vite.config.ts']).not.toContain("source.startsWith('/resources/");
	});

	it('keeps the tunnel host allow-list when generating vite config', () => {
		const files = buildSlidevExtraFiles({ remoteTunnel: true, presenterControlledNavigation: false });

		expect(files['vite.config.ts']).toContain("allowedHosts: ['trycloudflare.com', '.trycloudflare.com']");
	});
});

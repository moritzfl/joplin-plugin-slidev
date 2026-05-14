import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMarkdownPreprocessor } from '../src/markdownPreprocessor';

const resourceId = '0123456789abcdef0123456789abcdef';
const getMock = vi.hoisted(() => vi.fn());

vi.mock('api', () => ({
	default: {
		data: {
			get: getMock,
		},
	},
}));

const baseOptions = {
	disableCompatFixes: false,
	defaultTheme: '',
	colorSchema: '',
	aspectRatio: '',
	lineNumbers: '',
	wakeLock: '',
	selectable: '',
	contextMenu: '',
	overviewSnapshots: '',
	embedAudioResources: false,
	embedVideoResources: false,
	embedPdfResources: false,
	slideNumber: '',
	slideProgressBar: '',
};

let tempDirs: string[] = [];

afterEach(async () => {
	getMock.mockReset();
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
	tempDirs = [];
});

const makeTempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'slidev-joplin-'));
	tempDirs.push(dir);
	return dir;
};

const mockResource = (metadata: { file_extension: string; mime: string; filename: string }, data = 'resource-data') => {
	getMock.mockImplementation(async (path: string[]) => {
		if (path[0] !== 'resources' || path[1] !== resourceId) return undefined;
		if (path[2] === 'file') return Buffer.from(data);
		return metadata;
	});
};

describe('markdownPreprocessor', () => {
	it('copies resources beside slides.md and rewrites them as relative imports', async () => {
		mockResource({
			file_extension: 'png',
			mime: 'image/png',
			filename: 'usage-overall-by-subscriber.png',
		});

		const workDir = await makeTempDir();
		const preprocess = makeMarkdownPreprocessor(baseOptions);
		const result = await preprocess(`![chart](:/${resourceId})`, workDir);

		expect(result).toContain('![chart](./resources/usage-overall-by-subscriber.png)');
		expect(result).not.toContain('](/resources/usage-overall-by-subscriber.png)');
		await expect(readFile(join(workDir, 'resources', 'usage-overall-by-subscriber.png'), 'utf-8'))
			.resolves.toBe('resource-data');
	});

	it('preserves escaped labels, whitespace, and titles in inline resource links', async () => {
		mockResource({
			file_extension: 'png',
			mime: 'image/png',
			filename: 'diagram final.png',
		});

		const workDir = await makeTempDir();
		const preprocess = makeMarkdownPreprocessor(baseOptions);
		const result = await preprocess([
			`![chart \\] one]( :/${resourceId} "Diagram" )`,
			`[doc \\] link]( :/${resourceId} 'Doc' )`,
		].join('\n'), workDir);

		expect(result).toContain('![chart \\] one](./resources/diagram%20final.png "Diagram")');
		expect(result).toContain("[doc \\] link](./resources/diagram%20final.png 'Doc')");
		expect(result).not.toContain(`:/${resourceId}`);
	});

	it('rewrites reference-style resource destinations', async () => {
		mockResource({
			file_extension: 'png',
			mime: 'image/png',
			filename: 'chart.png',
		});

		const workDir = await makeTempDir();
		const preprocess = makeMarkdownPreprocessor(baseOptions);
		const result = await preprocess(`![chart][chart-ref]\n\n[chart-ref]: :/${resourceId} "Diagram"`, workDir);

		expect(result).toContain('![chart][chart-ref]');
		expect(result).toContain('[chart-ref]: ./resources/chart.png "Diagram"');
		expect(result).not.toContain(`:/${resourceId}`);
	});

	it('embeds media links with whitespace and titles', async () => {
		mockResource({
			file_extension: 'mp3',
			mime: 'audio/mpeg',
			filename: 'theme song.mp3',
		});

		const workDir = await makeTempDir();
		const preprocess = makeMarkdownPreprocessor({ ...baseOptions, embedAudioResources: true });
		const result = await preprocess(`[listen]( :/${resourceId} "Theme song" )`, workDir);

		expect(result).toContain('<audio src="./resources/theme%20song.mp3" controls style="width: 100%;"></audio>');
		expect(result).not.toContain(`:/${resourceId}`);
	});
});

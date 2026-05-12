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

describe('markdownPreprocessor', () => {
	it('copies resources beside slides.md and rewrites them as relative imports', async () => {
		getMock.mockImplementation(async (path: string[]) => {
			if (path[0] !== 'resources' || path[1] !== resourceId) return undefined;
			if (path[2] === 'file') return Buffer.from('image-data');
			return {
				file_extension: 'png',
				mime: 'image/png',
				filename: 'usage-overall-by-subscriber.png',
			};
		});

		const workDir = await makeTempDir();
		const preprocess = makeMarkdownPreprocessor(baseOptions);
		const result = await preprocess(`![chart](:/${resourceId})`, workDir);

		expect(result).toContain('![chart](./resources/usage-overall-by-subscriber.png)');
		expect(result).not.toContain('](/resources/usage-overall-by-subscriber.png)');
		await expect(readFile(join(workDir, 'resources', 'usage-overall-by-subscriber.png'), 'utf-8'))
			.resolves.toBe('image-data');
	});
});

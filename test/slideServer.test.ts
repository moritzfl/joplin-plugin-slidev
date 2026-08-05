import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/slidevExtraFiles/styles-index.css', () => ({ default: '' }));
vi.mock('../src/slidevExtraFiles/styles-presenter.css', () => ({ default: '' }));
vi.mock('../src/slidevExtraFiles/global-top.vue', () => ({ default: '' }));
vi.mock('../src/slidevExtraFiles/global-bottom.vue', () => ({ default: '' }));

import {
	ensureSlidevWorkspace,
	buildNodeChildEnv,
	findAvailablePort,
	slidevWorkspaceDir,
	startSlidevServer,
	stopSlidevServer,
	SlidevServer,
} from '../src/slideServer';

const tempDirs: string[] = [];
const servers: SlidevServer[] = [];

const makeTempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'slidev-server-'));
	tempDirs.push(dir);
	return dir;
};

const createInstalledWorkspace = async (dataDir: string, slidevScript = 'setInterval(() => {}, 1000);') => {
	const workspaceDir = slidevWorkspaceDir(dataDir);
	const packages = [
		['@slidev/cli', '52.19.0'],
		['@slidev/theme-default', '0.25.0'],
		['@slidev/theme-seriph', '0.25.0'],
	] as const;
	for (const [packageName, version] of packages) {
		const packageDir = join(workspaceDir, 'node_modules', ...packageName.split('/'));
		await mkdir(packageDir, { recursive: true });
		const pkg = packageName === '@slidev/cli'
			? { name: packageName, version, bin: { slidev: 'bin/slidev.js' } }
			: { name: packageName, version };
		await writeFile(join(packageDir, 'package.json'), JSON.stringify(pkg));
	}
	const slidevBinDir = join(workspaceDir, 'node_modules', '@slidev', 'cli', 'bin');
	await mkdir(slidevBinDir, { recursive: true });
	await writeFile(join(slidevBinDir, 'slidev.js'), slidevScript);
	return workspaceDir;
};

afterEach(async () => {
	const closingServers = servers.splice(0);
	for (const server of closingServers) stopSlidevServer(server);
	await Promise.all(closingServers.map(server => server.closed));
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('slideServer', () => {
	it('runs Node CLIs through Electron in Node mode', () => {
		expect(buildNodeChildEnv(true).ELECTRON_RUN_AS_NODE).toBe('1');
	});

	it('rejects ports outside the valid TCP range', async () => {
		await expect(findAvailablePort(0)).rejects.toThrow('Invalid Slidev port');
		await expect(findAvailablePort(65536)).rejects.toThrow('Invalid Slidev port');
	});

	it('preserves installed package dependencies while repairing workspace metadata', async () => {
		const dataDir = await makeTempDir();
		const workspaceDir = await createInstalledWorkspace(dataDir);
		await writeFile(join(workspaceDir, 'package.json'), JSON.stringify({
			name: 'existing-workspace',
			dependencies: { 'slidev-addon-existing': '1.2.3' },
		}));

		await ensureSlidevWorkspace(dataDir, () => {});

		const pkg = JSON.parse(await readFile(join(workspaceDir, 'package.json'), 'utf-8'));
		expect(pkg.dependencies).toMatchObject({
			'@slidev/cli': '52.19.0',
			'@slidev/theme-default': '0.25.0',
			'@slidev/theme-seriph': '0.25.0',
			'slidev-addon-existing': '1.2.3',
		});
	});

	it('uses isolated deck directories for concurrent presentations', async () => {
		const dataDir = await makeTempDir();
		await createInstalledWorkspace(dataDir);

		const first = await startSlidevServer('# First', dataDir, 3030);
		servers.push(first);
		const second = await startSlidevServer('# Second', dataDir, 3031);
		servers.push(second);

		expect(first.workDir).not.toBe(second.workDir);
		await expect(access(join(first.workDir, 'slides.md'))).resolves.toBeUndefined();
		await expect(access(join(second.workDir, 'slides.md'))).resolves.toBeUndefined();

		stopSlidevServer(first);
		await first.closed;
		await expect(access(first.workDir)).rejects.toThrow();
	});

	it('reports a Slidev process that exits during startup', async () => {
		const dataDir = await makeTempDir();
		await createInstalledWorkspace(dataDir, 'process.exit(2);');

		await expect(startSlidevServer('# Broken', dataDir, 3030)).rejects.toThrow('exited with code 2 before startup');
	});
});

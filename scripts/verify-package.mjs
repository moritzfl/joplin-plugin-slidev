import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable');

const tempDir = await mkdtemp(join(tmpdir(), 'slidev-package-'));
try {
	const pack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', tempDir], {
		cwd: rootDir,
		encoding: 'utf-8',
	});
	if (pack.status !== 0) throw new Error(pack.stderr || pack.stdout || 'npm pack failed');
	const [packed] = JSON.parse(pack.stdout);
	const actualFiles = packed.files.map(file => file.path).sort();
	const expectedFiles = [
		'LICENSE',
		'README.md',
		'package.json',
		'publish/de.moritzf.slidev-integration.jpl',
		'publish/de.moritzf.slidev-integration.json',
	];
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error(`Unexpected npm package contents:\n${actualFiles.join('\n')}`);
	}

	const tarball = join(tempDir, packed.filename);
	const installDir = join(tempDir, 'install');
	await mkdir(installDir);
	const install = spawnSync(process.execPath, [npmCli, 'install', '--prefix', installDir, tarball, '--no-audit', '--no-fund'], {
		cwd: installDir,
		encoding: 'utf-8',
	});
	if (install.status !== 0) throw new Error(install.stderr || install.stdout || 'packed package installation failed');
	console.info('Package contents and installation verified.');
} finally {
	await rm(tempDir, { recursive: true, force: true });
}

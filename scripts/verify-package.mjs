import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as tar from 'tar';

const rootDir = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable');

const readJson = async path => JSON.parse(await readFile(path, 'utf-8'));
const sha256 = content => createHash('sha256').update(content).digest('hex');
const gitOutput = args => {
	const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf-8' });
	if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	return result.stdout.trim();
};
const currentGitInfo = () => {
	const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
	const commit = gitOutput(['rev-parse', 'HEAD']);
	return `${branch}:${commit}${gitOutput(['status', '--porcelain']) ? '+dirty' : ''}`;
};

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

	const packageDir = join(installDir, 'node_modules', 'joplin-plugin-slidev');
	const packageJson = await readJson(join(packageDir, 'package.json'));
	const info = await readJson(join(packageDir, 'publish', 'de.moritzf.slidev-integration.json'));
	const jplPath = join(packageDir, 'publish', 'de.moritzf.slidev-integration.jpl');
	const jpl = await readFile(jplPath);
	const jplDir = join(tempDir, 'jpl');
	await mkdir(jplDir);
	await tar.x({ file: jplPath, cwd: jplDir, strict: true });
	const manifest = await readJson(join(jplDir, 'manifest.json'));

	if (packageJson.version !== manifest.version || info.version !== manifest.version) {
		throw new Error(`Package version mismatch: npm=${packageJson.version}, manifest=${manifest.version}, info=${info.version}`);
	}
	if (info.id !== manifest.id) throw new Error(`Plugin ID mismatch: manifest=${manifest.id}, info=${info.id}`);
	const expectedHash = `sha256:${sha256(jpl)}`;
	if (info._publish_hash !== expectedHash) {
		throw new Error(`Plugin hash mismatch: expected ${expectedHash}, got ${info._publish_hash}`);
	}
	const expectedCommit = currentGitInfo();
	if (info._publish_commit !== expectedCommit) {
		throw new Error(`Plugin commit mismatch: expected ${expectedCommit}, got ${info._publish_commit}`);
	}
	console.info('Package contents, metadata, hash, and installation verified.');
} finally {
	await rm(tempDir, { recursive: true, force: true });
}

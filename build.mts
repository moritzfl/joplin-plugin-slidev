// Build script for joplin-plugin-slidev.
// Adapted from the standard Joplin plugin build.mts template (esbuild-based).

import * as esbuild from 'esbuild';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as crypto from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import * as glob from 'glob';
import * as tar from 'tar';
import { copyFile, mkdir, stat } from 'node:fs/promises';

// @ts-ignore
const __filename = new URL(import.meta.url).pathname;
const __dirname = dirname(__filename);

const rootDir = resolve(__dirname);
const distDir = resolve(rootDir, 'dist');
const srcDir = resolve(rootDir, 'src');
const publishDir = resolve(rootDir, 'publish');

const manifestPath = `${srcDir}/manifest.json`;
const manifest = readManifest(manifestPath);
const pluginArchiveFilePath = resolve(publishDir, `${manifest.id}.jpl`);
const pluginInfoFilePath = resolve(publishDir, `${manifest.id}.json`);

function readManifest(path: string) {
	const content = readFileSync(path, 'utf8');
	const output = JSON.parse(content);
	if (!output.id) throw new Error(`Manifest plugin ID is not set in ${path}`);
	return output;
}

function fileSha256(filePath: string) {
	const content = readFileSync(filePath);
	return crypto.createHash('sha256').update(content).digest('hex');
}

function currentGitInfo() {
	try {
		const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }).toString().trim();
		const commit = execSync('git rev-parse HEAD', { stdio: 'pipe' }).toString().trim();
		return `${branch}:${commit}`;
	} catch {
		return '';
	}
}

async function createPluginArchive(sourceDir: string, destPath: string) {
	const distFiles = glob.sync(`${sourceDir}/**/*`, { nodir: true })
		.map(f => f.substring(sourceDir.length + 1));

	if (!distFiles.length) throw new Error('"dist" directory is empty — nothing to archive');
	if (existsSync(destPath)) unlinkSync(destPath);
	if (!existsSync(publishDir)) await mkdir(publishDir, { recursive: true });

	tar.create(
		{ strict: true, portable: true, file: destPath, cwd: sourceDir, sync: true },
		distFiles,
	);
	console.info(`Plugin archive created: ${destPath}`);
}

function createPluginInfo(manifestPath: string, destPath: string, jplFilePath: string) {
	const content = JSON.parse(readFileSync(manifestPath, 'utf8'));
	content._publish_hash = `sha256:${fileSha256(jplFilePath)}`;
	content._publish_commit = currentGitInfo();
	writeFileSync(destPath, JSON.stringify(content, null, '\t'), 'utf8');
}

async function bundle() {
	await esbuild.build({
		entryPoints: ['./src/index.ts'],
		outfile: join(distDir, 'index.js'),
		bundle: true,
		platform: 'node',
		target: 'node22',
		external: [
			// Keep Node.js built-ins and electron external so they are
			// resolved at runtime inside the Joplin plugin host.
			'electron',
			'child_process',
			'fs',
			'fs/promises',
			'path',
			'net',
			'os',
			'crypto',
		],
	});

	// Content scripts run in the renderer process, not the plugin host.
	await esbuild.build({
		entryPoints: ['./src/frontmatterRenderer.ts'],
		outfile: join(distDir, 'frontmatterRenderer.js'),
		bundle: true,
		platform: 'browser',
		target: 'es2017',
		format: 'cjs',
	});
}

async function copyAssets() {
	const assets = await glob.glob('**/*', {
		ignore: '**/*.{ts,tsx}',
		cwd: srcDir,
	});
	for (const asset of assets) {
		const srcPath = join(srcDir, asset);
		const fileStat = await stat(srcPath);
		if (fileStat.isFile()) {
			const destPath = join(distDir, asset);
			const destDir = dirname(destPath);
			await mkdir(destDir, { recursive: true });
			await copyFile(srcPath, destPath);
		} else {
			await mkdir(join(distDir, asset), { recursive: true });
		}
	}
}

async function build() {
	await bundle();
	await copyAssets();
	await createPluginArchive(distDir, pluginArchiveFilePath);
	createPluginInfo(manifestPath, pluginInfoFilePath, pluginArchiveFilePath);
	console.info('Build complete.');
}

const command = process.argv[2];
if (command === 'build') {
	build().catch(e => { console.error(e); process.exit(1); });
} else {
	console.warn('Unknown command:', command);
	process.exit(1);
}

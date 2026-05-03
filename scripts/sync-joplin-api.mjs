import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(rootDir, 'node_modules/generator-joplin/generators/app/templates/api');
const targetDir = resolve(rootDir, 'api');

if (!existsSync(sourceDir)) {
	throw new Error(`Joplin API template directory not found: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.info('Synced Joplin plugin API types from generator-joplin.');

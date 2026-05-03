// Renders icons/source.svg to PNG at the sizes Joplin expects.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const svg = readFileSync(resolve(root, 'icons/source.svg'), 'utf8');
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: size },
	});
	const png = resvg.render().asPng();
	const dest = resolve(root, `icons/icon-${size}.png`);
	writeFileSync(dest, png);
	console.log(`icons/icon-${size}.png`);
}

import joplin from 'api';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import MarkdownIt from 'markdown-it';

// Joplin resource IDs are 32-char lowercase hex strings.
const RESOURCE_ID_RE = /[a-f0-9]{32}/;
const RESOURCE_REF_RE = new RegExp(`:\/(${ RESOURCE_ID_RE.source })`, 'g');
const markdownParser = new MarkdownIt({ html: true, linkify: false, typographer: false });

interface MarkdownPreprocessorOptions {
	disableCompatFixes: boolean;
	defaultTheme: string;
	colorSchema: string;
	aspectRatio: string;
	lineNumbers: string;
	wakeLock: string;
	selectable: string;
	contextMenu: string;
	overviewSnapshots: string;
	embedAudioResources: boolean;
	embedVideoResources: boolean;
	embedPdfResources: boolean;
	slideProgress: string;
	skipMediaStopper?: boolean;
	// When set, resources are written here with relative ./resources/ URLs instead of
	// the Vite-served /resources/ paths used by the dev/export server.
	bundleOutputDir?: string;
}

interface ExportedResource {
	url: string;
	mime: string;
}

// ---------------------------------------------------------------------------
// Joplin resource export
// ---------------------------------------------------------------------------

const getResourceBuffer = async (id: string): Promise<Buffer | null> => {
	try {
		const raw = await joplin.data.get(['resources', id, 'file']);
		if (!raw) return null;
		if (Buffer.isBuffer(raw)) return raw;
		if (raw instanceof Uint8Array) return Buffer.from(raw);
		// Some Joplin versions wrap it: { body: Buffer | string, contentType: string }
		if (raw.body !== undefined) {
			const b = raw.body;
			if (Buffer.isBuffer(b)) return b;
			if (b instanceof Uint8Array) return Buffer.from(b);
			if (typeof b === 'string') return Buffer.from(b, 'binary');
		}
		// Older versions: { data: string (base64) }
		if (typeof raw.data === 'string') return Buffer.from(raw.data, 'base64');
		console.error('[Slidev] Unknown resource payload shape:', typeof raw, Object.keys(raw ?? {}));
		return null;
	} catch (e) {
		console.error(`[Slidev] getResourceBuffer(${id}) failed:`, e);
		return null;
	}
};

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

const encodeResourceUrl = (url: string) => {
	const slash = url.lastIndexOf('/');
	if (slash < 0) return encodeURIComponent(url);
	return `${url.slice(0, slash + 1)}${encodeURIComponent(url.slice(slash + 1))}`;
};

const rewriteResourceReferences = (
	markdown: string,
	resources: Map<string, ExportedResource>,
	options: MarkdownPreprocessorOptions,
) => {
	let result = markdown;

	result = result.replace(
		new RegExp(`!\\[([^\\]]*)\\]\\(:\/(${RESOURCE_ID_RE.source})\\)`, 'g'),
		(match, alt: string, id: string) => {
			const resource = resources.get(id);
			return resource ? `![${alt}](${resource.url})` : match;
		},
	);

	result = result.replace(
		new RegExp(`\\[([^\\]]*)\\]\\(:\/(${RESOURCE_ID_RE.source})\\)`, 'g'),
		(match, label: string, id: string) => {
			const resource = resources.get(id);
			if (!resource) return match;

			const safeUrl = escapeHtml(resource.url);
			const safeLabel = escapeHtml(label || 'Open attachment');
			if (options.embedAudioResources && resource.mime.startsWith('audio/')) {
				return `<audio src="${safeUrl}" controls style="width: 100%;"></audio>`;
			}
			if (options.embedVideoResources && resource.mime.startsWith('video/')) {
				return `<video src="${safeUrl}" controls style="max-width: 100%; max-height: 70vh;"></video>`;
			}
			if (options.embedPdfResources && resource.mime === 'application/pdf') {
				return `<embed src="${safeUrl}" type="application/pdf" title="${safeLabel}" style="width: 100%; height: 75vh;" />`;
			}
			return `[${label}](${resource.url})`;
		},
	);

	for (const [id, resource] of resources) {
		result = result.replace(new RegExp(`:\/${id}`, 'g'), resource.url);
	}

	return result;
};

const exportResources = async (
	markdown: string,
	workDir: string,
	options: MarkdownPreprocessorOptions,
): Promise<string> => {
	const ids = new Set<string>();
	for (const m of markdown.matchAll(RESOURCE_REF_RE)) ids.add(m[1]);
	if (ids.size === 0) return markdown;

	const resourceDir = options.bundleOutputDir
		? join(options.bundleOutputDir, 'resources')
		: join(workDir, 'public', 'resources');
	const urlPrefix = options.bundleOutputDir ? './resources/' : '/resources/';

	await mkdir(resourceDir, { recursive: true });

	const usedFilenames = new Set<string>();

	const uniqueFilename = (base: string, ext: string): string => {
		const candidate = `${base}.${ext}`;
		if (!usedFilenames.has(candidate)) { usedFilenames.add(candidate); return candidate; }
		let n = 2;
		while (usedFilenames.has(`${base}_${n}.${ext}`)) n++;
		const result = `${base}_${n}.${ext}`;
		usedFilenames.add(result);
		return result;
	};

	const exportedResources = new Map<string, ExportedResource>();
	for (const id of ids) {
		try {
			const meta = await joplin.data.get(['resources', id], {
				fields: ['id', 'file_extension', 'mime', 'filename', 'title'],
			}) as { file_extension?: string; mime?: string; filename?: string; title?: string };

			// Derive extension from metadata or mime type.
			let ext = (meta.file_extension ?? '').replace(/^\./, '');
			if (!ext && meta.mime) {
				const mimeExt: Record<string, string> = {
					'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
					'image/webp': 'webp', 'image/svg+xml': 'svg',
					'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
					'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
					'application/pdf': 'pdf',
				};
				ext = mimeExt[meta.mime] ?? 'bin';
			}
			ext = ext || 'bin';

			// Prefer the original filename, fall back to title, then the ID hash.
			// Strip any extension already present so we don't get double extensions.
			const rawName = (meta.filename || meta.title || '').replace(/\.[^.]+$/, '');
			const base = rawName
				? rawName.replace(/[^\w\s.\-]/g, '_').trim() || id
				: id;

			const filename = uniqueFilename(base, ext);
			const buf = await getResourceBuffer(id);
			if (!buf) {
				console.error(`[Slidev] Could not read resource ${id}, skipping.`);
				continue;
			}

			await writeFile(join(resourceDir, filename), buf);
			const url = encodeResourceUrl(`${urlPrefix}${filename}`);
			exportedResources.set(id, { url, mime: meta.mime ?? '' });
			console.log(`[Slidev] Exported resource ${id} → ${resourceDir}/${filename}`);
		} catch (e) {
			console.error(`[Slidev] Failed to export resource ${id}:`, e);
		}
	}
	return rewriteResourceReferences(markdown, exportedResources, options);
};

// ---------------------------------------------------------------------------
// Markdown sanitisation for Slidev/Vite
// ---------------------------------------------------------------------------

const normalizeFrontmatter = (markdown: string): string => {
	const frontmatterMatch = markdown.match(/^(\s*)---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
	if (!frontmatterMatch) return markdown;

	// Slidev's frontmatter parser is stricter than Joplin users expect. Blank
	// metadata lines such as "---\n\ntheme: seriph\n\n---" can break parsing.
	const normalizedFrontmatter = frontmatterMatch[2]
		.split(/\r?\n/)
		.filter(line => line.trim() !== '')
		.join('\n');

	const replacement = `${frontmatterMatch[1]}---\n${normalizedFrontmatter}\n---`;
	return markdown.replace(frontmatterMatch[0], replacement);
};

const applyDefaultTheme = (markdown: string, theme: string): string => {
	const trimmedTheme = theme.trim();
	if (!trimmedTheme) return markdown;

	const frontmatterMatch = markdown.match(/^(\s*)---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
	if (!frontmatterMatch) return `---\ntheme: ${trimmedTheme}\n---\n\n${markdown}`;

	const frontmatter = frontmatterMatch[2];
	if (/^theme\s*:/m.test(frontmatter)) return markdown;

	const replacement = `${frontmatterMatch[1]}---\n${frontmatter}\ntheme: ${trimmedTheme}\n---`;
	return markdown.replace(frontmatterMatch[0], replacement);
};

const applyDefaultColorSchema = (markdown: string, colorSchema: string): string => {
	const schema = colorSchema.trim();
	if (!['auto', 'dark', 'light'].includes(schema)) return markdown;

	const frontmatterMatch = markdown.match(/^(\s*)---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
	if (!frontmatterMatch) return `---\ncolorSchema: ${schema}\n---\n\n${markdown}`;

	const frontmatter = frontmatterMatch[2];
	if (/^colorSchema\s*:/m.test(frontmatter)) return markdown;

	const replacement = `${frontmatterMatch[1]}---\n${frontmatter}\ncolorSchema: ${schema}\n---`;
	return markdown.replace(frontmatterMatch[0], replacement);
};

const applyDefaultHeadmatterSetting = (markdown: string, key: string, value: string): string => {
	const sanitizedValue = value.trim();
	if (!sanitizedValue) return markdown;

	const frontmatterMatch = markdown.match(/^(\s*)---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
	if (!frontmatterMatch) return `---\n${key}: ${sanitizedValue}\n---\n\n${markdown}`;

	const frontmatter = frontmatterMatch[2];
	if (new RegExp(`^${key}\\s*:`, 'm').test(frontmatter)) return markdown;

	const replacement = `${frontmatterMatch[1]}---\n${frontmatter}\n${key}: ${sanitizedValue}\n---`;
	return markdown.replace(frontmatterMatch[0], replacement);
};

const applyDefaultHeadmatterSettings = (markdown: string, options: MarkdownPreprocessorOptions): string => {
	let result = markdown;
	const supportedBooleans = new Set(['true', 'false']);
	const applyBoolean = (key: string, value: string) => {
		if (supportedBooleans.has(value)) result = applyDefaultHeadmatterSetting(result, key, value);
	};

	if (['16/9', '4/3', '1/1'].includes(options.aspectRatio)) {
		result = applyDefaultHeadmatterSetting(result, 'aspectRatio', options.aspectRatio);
	}
	applyBoolean('lineNumbers', options.lineNumbers);
	applyBoolean('wakeLock', options.wakeLock);
	applyBoolean('selectable', options.selectable);
	applyBoolean('contextMenu', options.contextMenu);
	applyBoolean('overviewSnapshots', options.overviewSnapshots);
	result = applyDefaultHeadmatterSetting(result, 'editor', 'false');
	return result;
};

const MEDIA_STOPPER_SCRIPT = `
<script setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'

const stopMedia = () => {
  for (const el of document.querySelectorAll('audio, video')) {
    el.pause()
    el.currentTime = 0
  }
}

const route = useRoute()
let unwatch

onMounted(() => {
  unwatch = watch(() => route.fullPath, stopMedia)
  window.addEventListener('hashchange', stopMedia)
  window.addEventListener('popstate', stopMedia)
})

onUnmounted(() => {
  unwatch?.()
  window.removeEventListener('hashchange', stopMedia)
  window.removeEventListener('popstate', stopMedia)
})
</script>
`;

const injectMediaStopper = (markdown: string): string => {
	if (!/<(?:audio|video)\b/i.test(markdown)) return markdown;

	const frontmatterMatch = markdown.match(/^(\s*---\r?\n[\s\S]*?\r?\n---)(?=\r?\n|$)/);
	if (!frontmatterMatch) return `${MEDIA_STOPPER_SCRIPT}\n${markdown}`;

	return markdown.replace(frontmatterMatch[0], `${frontmatterMatch[0]}\n${MEDIA_STOPPER_SCRIPT}`);
};

// Regex that matches a complete fenced code block (``` or ~~~).
const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;

const applyOutsideFences = (markdown: string, fn: (chunk: string) => string): string => {
	let result = '';
	let last = 0;
	for (const match of markdown.matchAll(FENCE_RE)) {
		result += fn(markdown.slice(last, match.index));
		result += match[0];
		last = match.index! + match[0].length;
	}
	return result + fn(markdown.slice(last));
};

const rewriteAsteriskBullets = (markdown: string): string =>
	(() => {
		const lines = markdown.split(/(\r?\n)/);
		const contentLines: string[] = [];
		for (let i = 0; i < lines.length; i += 2) contentLines.push(lines[i]);

		const rewriteLines = new Set<number>();
		const tokens = markdownParser.parse(markdown, {});
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.type !== 'list_item_open' || !token.map) continue;
			const firstLine = token.map[0];
			const line = contentLines[firstLine] ?? '';
			if (/^\s*\*\s+/.test(line)) rewriteLines.add(firstLine);
		}

		for (const lineIndex of rewriteLines) {
			contentLines[lineIndex] = contentLines[lineIndex].replace(/^(\s*)\*\s+/, '$1- ');
		}

		let result = '';
		for (let i = 0; i < contentLines.length; i++) {
			result += contentLines[i];
			result += lines[(i * 2) + 1] ?? '';
		}
		return result;
	})();

const sanitiseForSlidev = (markdown: string): string =>
	applyOutsideFences(markdown, chunk => rewriteAsteriskBullets(chunk)
		// Strip any :/id refs that weren't successfully exported (Vite can't import them).
		.replace(/!\[([^\]]*)\]\(:\/[a-f0-9]+\)/g, '*[image — Joplin resource]*')
		.replace(/\[([^\]]*)\]\(:\/[a-f0-9]+\)/g, '$1')
		.replace(/:\/[a-f0-9]+/g, ''),
	);

// ---------------------------------------------------------------------------
// Public entry point — used as the preprocessMarkdown callback in startSlidevServer
// ---------------------------------------------------------------------------

export const makeMarkdownPreprocessor = (options: MarkdownPreprocessorOptions) =>
	async (markdown: string, workDir: string): Promise<string> => {
		let result = normalizeFrontmatter(markdown);
		result = applyDefaultTheme(result, String(options.defaultTheme ?? ''));
		result = applyDefaultColorSchema(result, String(options.colorSchema ?? ''));
		result = applyDefaultHeadmatterSettings(result, options);
		result = await exportResources(result, workDir, options);
		if (!options.skipMediaStopper) result = injectMediaStopper(result);
		if (!options.disableCompatFixes) result = sanitiseForSlidev(result);
		return result;
	};

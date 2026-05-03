import joplin from 'api';
import { FileSystemItem } from 'api/types';
import { writeFile, mkdir } from 'fs/promises';
import { makeMarkdownPreprocessor } from '../markdownPreprocessor';
import { getSettings } from '../settings';
import { exportSlidevDeck } from '../slideServer';
import { pluginPrefix } from '../constants';
import { join } from 'path';
import { buildSlidevExtraFiles } from '../slidevExtraFiles';
import { esc, render } from '../htmlUtils';
import style from './exportProgress.css';
import progressTemplate from './exportProgressDialog.html';

type SlidevExportFormat = 'pdf' | 'pptx' | 'png';

interface PendingNote {
	id: string;
	body: string;
}

const dialogs = joplin.views.dialogs;

const ts = () => new Date().toLocaleTimeString();

type ProgressState = 'running' | 'success' | 'error';

const exportProgressHtml = (title: string, status: string, logs: string[], state: ProgressState) => {
	const logContent = logs.length === 0
		? '<span style="opacity:0.4">Waiting for Slidev export output...</span>'
		: logs.map(l => `<div class="line">${esc(l)}</div>`).join('');

	return render(progressTemplate, {
		STYLE: style,
		DOT_CLASS: state === 'running' ? '' : state,
		SYMBOL: state === 'success' ? '✓' : state === 'error' ? '!' : '›',
		TITLE: esc(title),
		STATUS: esc(status),
		LOG: logContent,
	});
};

let exportProgressCounter = 0;

const createExportProgress = async (title: string) => {
	const handle = await dialogs.create(`${pluginPrefix}exportProgress${++exportProgressCounter}`);
	await dialogs.setFitToContent(handle, false);
	await dialogs.setButtons(handle, [{ id: 'close', title: 'Close' }]);
	const logs: string[] = [];
	const MAX_LOG_LINES = 80;
	let updateScheduled = false;
	let status = 'Preparing export...';
	let state: ProgressState = 'running';

	const update = async () => {
		updateScheduled = false;
		try {
			await dialogs.setHtml(handle, exportProgressHtml(title, status, logs.slice(-MAX_LOG_LINES), state));
		} catch {
			// The user may close the progress dialog while export continues.
		}
	};

	const scheduleUpdate = () => {
		if (updateScheduled) return;
		updateScheduled = true;
		setTimeout(() => { update().catch(() => {}); }, 150);
	};

	await update();
	void dialogs.open(handle);

	return {
		log(line: string) {
			logs.push(`[${ts()}]  ${line}`);
			status = 'Exporting...';
			scheduleUpdate();
		},
		async done(outputPath: string) {
			state = 'success';
			status = `Finished: ${outputPath}`;
			logs.push(`[${ts()}]  Export finished: ${outputPath}`);
			await update();
		},
		async failed(error: unknown) {
			state = 'error';
			status = 'Export failed';
			logs.push(`[${ts()}]  Export failed: ${(error as Error).message ?? String(error)}`);
			await update();
		},
	};
};

const getSourceNote = async (context: any): Promise<PendingNote> => {
	const notes = (context.userData?.notes ?? []) as PendingNote[];
	if (notes.length === 1) return notes[0];

	const sourceNoteIds = context.options?.sourceNoteIds as string[] | undefined;
	if (sourceNoteIds?.length === 1) {
		const note = await joplin.data.get(['notes', sourceNoteIds[0]], { fields: ['id', 'body'] }) as PendingNote;
		return { id: note.id, body: String(note.body ?? '') };
	}

	throw new Error('Slidev export supports one selected note at a time.');
};

const registerSlidevExportModule = async (
	format: SlidevExportFormat,
	description: string,
	target: FileSystemItem,
	fileExtensions?: string[],
) => {
	await joplin.interop.registerExportModule({
		format: `slidev-${format}`,
		description,
		target,
		isNoteArchive: false,
		fileExtensions,
		onInit: async (context) => {
			context.userData = { notes: [] as PendingNote[] };
		},
		onProcessItem: async (context, _itemType, item) => {
			if (typeof item?.body !== 'string' || typeof item?.id !== 'string') return;
			(context.userData.notes as PendingNote[]).push({ id: item.id, body: item.body });
		},
		onProcessResource: async () => {},
		onClose: async (context) => {
			const progress = await createExportProgress(description);
			const note = await getSourceNote(context);
			const settings = await getSettings();
			const dataDir = await joplin.plugins.dataDir();
			const outputPath = context.destPath;

			try {
				await exportSlidevDeck(
					note.body,
					dataDir,
					format,
					outputPath,
					(line) => {
						console.log(`[Slidev export:${format}] ${line}`);
						progress.log(line);
					},
					makeMarkdownPreprocessor({
						disableCompatFixes: settings.disableMarkdownCompatFixes,
						defaultTheme: settings.defaultTheme,
						colorSchema: settings.colorSchema,
						aspectRatio: settings.aspectRatio,
						lineNumbers: settings.lineNumbers,
						wakeLock: settings.wakeLock,
						selectable: settings.selectable,
						contextMenu: settings.contextMenu,
						overviewSnapshots: settings.overviewSnapshots,
						embedAudioResources: settings.embedAudioResources,
						embedVideoResources: settings.embedVideoResources,
						embedPdfResources: settings.embedPdfResources,
						slideProgress: '',
							skipMediaStopper: true,
					}),
					buildSlidevExtraFiles(settings),
				);
				await progress.done(outputPath);
			} catch (e) {
				await progress.failed(e);
				throw e;
			}
		},
	});
};

const registerSlidevMarkdownBundleExportModule = async () => {
	await joplin.interop.registerExportModule({
		format: 'slidev-md',
		description: 'Markdown with resources',
		target: FileSystemItem.Directory,
		isNoteArchive: false,
		onInit: async (context) => {
			context.userData = { notes: [] as PendingNote[] };
		},
		onProcessItem: async (context, _itemType, item) => {
			if (typeof item?.body !== 'string' || typeof item?.id !== 'string') return;
			(context.userData.notes as PendingNote[]).push({ id: item.id, body: item.body });
		},
		onProcessResource: async () => {},
		onClose: async (context) => {
			const description = 'Markdown with resources';
			const progress = await createExportProgress(description);
			const note = await getSourceNote(context);
			const settings = await getSettings();
			const outputDir = context.destPath;

			try {
				await mkdir(outputDir, { recursive: true });
				progress.log('Preprocessing markdown and exporting Joplin resources...');

				const preprocessor = makeMarkdownPreprocessor({
					disableCompatFixes: settings.disableMarkdownCompatFixes,
					defaultTheme: settings.defaultTheme,
					colorSchema: settings.colorSchema,
					aspectRatio: settings.aspectRatio,
					lineNumbers: settings.lineNumbers,
					wakeLock: settings.wakeLock,
					selectable: settings.selectable,
					contextMenu: settings.contextMenu,
					overviewSnapshots: settings.overviewSnapshots,
					embedAudioResources: settings.embedAudioResources,
					embedVideoResources: settings.embedVideoResources,
					embedPdfResources: settings.embedPdfResources,
					slideProgress: '',
					skipMediaStopper: true,
					bundleOutputDir: outputDir,
				});

				// workDir is only used by exportResources when bundleOutputDir is absent,
				// so passing outputDir here is safe.
				const processed = await preprocessor(note.body, outputDir);
				const mdPath = join(outputDir, 'slides.md');
				await writeFile(mdPath, processed, 'utf-8');
				progress.log(`Written: slides.md`);

				await progress.done(outputDir);
			} catch (e) {
				await progress.failed(e);
				throw e;
			}
		},
	});
};

export const registerSlidevExportModules = async () => {
	await registerSlidevExportModule('pdf', 'PDF', FileSystemItem.File, ['pdf']);
	await registerSlidevExportModule('pptx', 'PowerPoint', FileSystemItem.File, ['pptx']);
	await registerSlidevExportModule('png', 'PNG images', FileSystemItem.Directory);
	await registerSlidevMarkdownBundleExportModule();
};

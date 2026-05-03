import joplin from 'api';
// electron is available at runtime inside Joplin (Electron app) but has no bundled types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
import { pluginPrefix } from '../constants';
import {
	findAvailablePort,
	startSlidevServer,
	stopSlidevServer,
	SlidevServer,
	waitForServerReady,
} from '../slideServer';
import { makeMarkdownPreprocessor } from '../markdownPreprocessor';
import { PluginSettings } from '../types';
import { buildSlidevExtraFiles } from '../slidevExtraFiles';
import { esc, render } from '../htmlUtils';
import style from './slidevDialog.css';
import loadingTemplate from './loadingDialog.html';
import failedTemplate from './failedDialog.html';
import readyTemplate from './readyDialog.html';

const dialogs = joplin.views.dialogs;
const dialogId = `${pluginPrefix}slidevDialog`;

// ---------- HTML templates ----------

const ts = () => new Date().toLocaleTimeString();

const logContent = (logs: string[], empty: string) =>
	logs.length === 0
		? `<span style="opacity:0.4">${empty}</span>`
		: logs.map(l => `<div class="line">${esc(l)}</div>`).join('');

const loadingHtml = (port: number, logs: string[]) =>
	render(loadingTemplate, {
		STYLE: style,
		PORT: String(port),
		LOG: logContent(logs, 'Waiting for Slidev output…'),
	});

const failedHtml = (logs: string[]) =>
	render(failedTemplate, {
		STYLE: style,
		LOG: logContent(logs, 'No output.'),
	});

const readyHtml = (port: number, logs: string[]) =>
	render(readyTemplate, {
		STYLE: style,
		PORT: String(port),
		LOG: logContent(logs, 'No output yet…'),
	});

// ---------- dialog handle ----------

const slidevUrl = (port: number, view: string): string => {
	if (view === 'presenter') return `http://localhost:${port}/presenter`;
	if (view === 'overview') return `http://localhost:${port}/overview`;
	return `http://localhost:${port}`;
};

let handle: string | undefined;

const getHandle = async (): Promise<string> => {
	if (!handle) handle = await dialogs.create(dialogId);
	return handle;
};

// ---------- public entry point ----------

export const showSlidevPresentation = async (
	markdown: string,
	settings: PluginSettings,
	dataDir: string,
): Promise<void> => {
	const dlg = await getHandle();

	const port = await findAvailablePort(settings.defaultPort);
	const initialUrl = slidevUrl(port, settings.initialView);

	await dialogs.setFitToContent(dlg, false);
	await dialogs.setHtml(dlg, loadingHtml(port, []));
	await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Cancel' }]);

	let server: SlidevServer | null = null;
	let cancelled = false;
	let serverReady = false;
	let serverFailed = false;

	const logLines: string[] = [];
	const MAX_LOG_LINES = 30;
	let updateScheduled = false;

	const scheduleHtmlUpdate = () => {
		if (updateScheduled || cancelled) return;
		updateScheduled = true;
		setTimeout(async () => {
			updateScheduled = false;
			if (cancelled) return;
			const slice = logLines.slice(-MAX_LOG_LINES);
			const html = serverReady
				? readyHtml(port, slice)
				: serverFailed
					? failedHtml(slice)
					: loadingHtml(port, slice);
			try {
				await dialogs.setHtml(dlg, html);
			} catch { /* dialog may have been closed */ }
		}, 150);
	};

	const preprocess = makeMarkdownPreprocessor({
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
	});

	const extraFiles = buildSlidevExtraFiles(settings);

	// Slidev prints "localhost:<port>" in its startup table when the server is ready.
	// We detect that here instead of TCP-polling, which is unreliable in the plugin sandbox.
	const handleServerReady = async () => {
		if (cancelled || serverReady) return;
		serverReady = true;
		if (settings.initialView !== 'none') {
			try { shell.openExternal(initialUrl); } catch { /* ignore */ }
		}
		try {
			await dialogs.setHtml(dlg, readyHtml(port, logLines.slice(-MAX_LOG_LINES)));
			await dialogs.setButtons(dlg, [
				{ id: 'open-browser', title: 'Presentation' },
				{ id: 'open-presenter', title: 'Presenter' },
				{ id: 'open-overview', title: 'Overview' },
				{ id: 'cancel', title: 'Close' },
			]);
		} catch { /* dialog may have been closed */ }
	};

	const serverTask = (async () => {
		try {
			server = await startSlidevServer(
				markdown,
				dataDir,
				port,
				(line) => {
					if (cancelled) return;
					logLines.push(`[${ts()}]  ${line}`);
					scheduleHtmlUpdate();
					// Slidev prints the localhost URL in its startup table when ready.
					if (!serverReady && line.includes(`localhost:${port}`)) {
						handleServerReady().catch(() => {});
					}
				},
				preprocess,
				extraFiles,
			);

			// Any Slidev process exit while the dialog is open is a failure —
			// whether it crashed before ready or after.
			server.process.once('close', (code) => {
				if (cancelled) return;
				logLines.push(`[${ts()}]  Process exited with code ${code}.`);
				serverReady = false;
				serverFailed = true;
				scheduleHtmlUpdate();
				dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]).catch(() => {});
			});

			waitForServerReady(port, 60000).then((ready) => {
				if (ready) {
					handleServerReady().catch(() => {});
				} else if (!serverReady && !serverFailed && !cancelled) {
					logLines.push(`[${ts()}]  Timed out waiting for Slidev to become ready.`);
					serverFailed = true;
					scheduleHtmlUpdate();
					dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]).catch(() => {});
				}
			}).catch(() => {});
			if (cancelled) stopSlidevServer(server);
		} catch (e) {
			if (cancelled) return;
			logLines.push(`[${ts()}]  Error: ${(e as Error).message ?? String(e)}`);
			serverFailed = true;
			scheduleHtmlUpdate();
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
		}
	})();

	// Open dialog — loop so "Presentation" re-opens without closing.
	let result = await dialogs.open(dlg);
	while (result?.id === 'open-browser' || result?.id === 'open-presenter' || result?.id === 'open-overview') {
		if (result.id === 'open-presenter') shell.openExternal(slidevUrl(port, 'presenter'));
		else if (result.id === 'open-overview') shell.openExternal(slidevUrl(port, 'overview'));
		else shell.openExternal(slidevUrl(port, 'slides'));
		result = await dialogs.open(dlg);
	}
	cancelled = true;

	await serverTask;
	if (server) stopSlidevServer(server);
};

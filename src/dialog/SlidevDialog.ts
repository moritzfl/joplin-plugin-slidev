import joplin from 'api';
import { Resolver } from 'dns/promises';
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

const readyHtml = (port: number, logs: string[], tunnelEntryUrl = '', tunnelEnabled = false, status = '') =>
	render(readyTemplate, {
		STYLE: style,
		PORT: String(port),
		TUNNEL: tunnelEnabled ? `<div class="url">Tunnel Entry: ${esc(tunnelEntryUrl || 'waiting for Cloudflare URL...')}</div>` : '',
		STATUS: status ? `<div class="status">${esc(status)}</div>` : '',
		LOG: logContent(logs, 'No output yet…'),
	});

// ---------- dialog handle ----------

const slidevUrl = (port: number, view: string): string => {
	if (view === 'presenter') return `http://localhost:${port}/presenter`;
	if (view === 'overview') return `http://localhost:${port}/overview`;
	return `http://localhost:${port}`;
};

const cloudflareResolver = new Resolver();
cloudflareResolver.setServers(['1.1.1.1', '1.0.0.1']);

const isHostnameResolvable = async (url: string): Promise<boolean> => {
	try {
		const hostname = new URL(url).hostname;
		try {
			await cloudflareResolver.resolve4(hostname);
		} catch {
			await cloudflareResolver.resolve6(hostname);
		}
		return true;
	} catch {
		return false;
	}
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
	let tunnelEntryUrl = '';
	let tunnelStatus = '';
	const tunnelEnabled = settings.remoteTunnel;

	const logLines: string[] = [];
	const MAX_LOG_LINES = 30;
	let updateScheduled = false;
	let statusClearTimer: ReturnType<typeof setTimeout> | undefined;

	const scheduleHtmlUpdate = () => {
		if (updateScheduled || cancelled) return;
		updateScheduled = true;
		setTimeout(async () => {
			updateScheduled = false;
			if (cancelled) return;
			const slice = logLines.slice(-MAX_LOG_LINES);
			const html = serverReady
				? readyHtml(port, slice, tunnelEntryUrl, tunnelEnabled, tunnelStatus)
				: serverFailed
					? failedHtml(slice)
					: loadingHtml(port, slice);
			try {
				await dialogs.setHtml(dlg, html);
			} catch { /* dialog may have been closed */ }
		}, 150);
	};

	const setTunnelStatus = (message: string) => {
		tunnelStatus = message;
		if (statusClearTimer) clearTimeout(statusClearTimer);
		statusClearTimer = setTimeout(() => {
			tunnelStatus = '';
			scheduleHtmlUpdate();
		}, 6000);
		scheduleHtmlUpdate();
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
		slideNumber: settings.slideNumber,
		slideProgressBar: settings.slideProgressBar,
	});

	const extraFiles = buildSlidevExtraFiles(settings);

	// Slidev prints "localhost:<port>" in its startup table when the server is ready.
	// Treat that as the fastest signal; waitForServerReady below is a fallback.
	const handleServerReady = async () => {
		if (cancelled || serverReady) return;
		serverReady = true;
		if (settings.initialView !== 'none') {
			try { shell.openExternal(initialUrl); } catch { /* ignore */ }
		}
		try {
			await dialogs.setHtml(dlg, readyHtml(port, logLines.slice(-MAX_LOG_LINES), tunnelEntryUrl, tunnelEnabled, tunnelStatus));
			const buttons = [
				{ id: 'open-browser', title: 'Presentation' },
				{ id: 'open-presenter', title: 'Presenter' },
				{ id: 'open-overview', title: 'Overview' },
			];
			if (tunnelEnabled) {
				buttons.push({ id: 'open-tunnel-entry', title: 'Tunnel Entry' });
			}
			buttons.push(
				{ id: 'cancel', title: 'Close' },
			);
			await dialogs.setButtons(dlg, buttons);
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
					const tunnelMatch = line.match(/remote via tunnel\s*>\s*(https?:\/\/\S+)/);
					if (tunnelMatch) {
						tunnelEntryUrl = tunnelMatch[1];
					}
					scheduleHtmlUpdate();
					// Prefer Slidev's own ready log over waiting for the TCP fallback.
					if (!serverReady && line.includes(`localhost:${port}`)) {
						handleServerReady().catch(() => {});
					}
				},
				preprocess,
				extraFiles,
				{
					remoteAccess: settings.remoteAccess,
					remotePassword: settings.remotePassword,
					remoteTunnel: settings.remoteTunnel,
					remoteBind: settings.remoteBind,
				},
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
	while (
		result?.id === 'open-browser'
		|| result?.id === 'open-presenter'
		|| result?.id === 'open-overview'
		|| result?.id === 'open-tunnel-entry'
	) {
		if (result.id === 'open-presenter') shell.openExternal(slidevUrl(port, 'presenter'));
		else if (result.id === 'open-overview') shell.openExternal(slidevUrl(port, 'overview'));
		else if (result.id === 'open-tunnel-entry') {
			if (!tunnelEntryUrl) {
				setTunnelStatus('Cloudflare tunnel entry is not ready yet. Wait until Slidev logs "remote via tunnel".');
			} else if (await isHostnameResolvable(tunnelEntryUrl)) {
				shell.openExternal(tunnelEntryUrl);
			} else {
				setTunnelStatus('Cloudflare tunnel host is not resolvable yet. Wait a few seconds and try again.');
			}
		}
		else shell.openExternal(slidevUrl(port, 'slides'));
		result = await dialogs.open(dlg);
	}
	cancelled = true;

	await serverTask;
	if (statusClearTimer) clearTimeout(statusClearTimer);
	if (server) stopSlidevServer(server);
};

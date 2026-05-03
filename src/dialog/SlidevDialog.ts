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

const dialogs = joplin.views.dialogs;
const dialogId = `${pluginPrefix}slidevDialog`;

// ---------- HTML templates ----------

const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ts = () => new Date().toLocaleTimeString();

const SHARED_STYLE = `
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:#12121e; color:#d0d0d8;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}`;

const loadingHtml = (port: number, logs: string[]) => {
	const logContent = logs.length === 0
		? '<span style="opacity:0.4">Waiting for Slidev output…</span>'
		: logs.map(l => `<div class="line">${esc(l)}</div>`).join('');

	return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
${SHARED_STYLE}
body { padding:28px 32px; height:100vh; display:flex; flex-direction:column; gap:16px; }
.header { display:flex; align-items:center; gap:14px; }
.spinner {
  width:22px; height:22px; flex-shrink:0;
  border:3px solid #2a2a3a; border-top-color:#42b883;
  border-radius:50%; animation:spin 0.8s linear infinite;
}
@keyframes spin { to { transform:rotate(360deg); } }
.title { font-size:15px; font-weight:500; }
.subtitle { font-size:12px; color:#555; margin-top:3px; }
.log {
  flex:1; overflow-y:auto;
  background:#0a0a14; border:1px solid #1e1e30; border-radius:6px;
  padding:10px 14px;
  font-family:'SF Mono','Fira Code','Cascadia Code',monospace;
  font-size:11.5px; line-height:1.75; color:#7ec89a;
}
.line { white-space:pre-wrap; word-break:break-all; }
</style></head>
<body>
<div class="header">
  <div class="spinner"></div>
  <div>
    <div class="title">Starting Slidev on port ${port}…</div>
  </div>
</div>
<div class="log" id="log">${logContent}</div>
<script>var el=document.getElementById('log');if(el)el.scrollTop=el.scrollHeight;</script>
</body></html>`;
};

const failedHtml = (logs: string[]) => {
	const logContent = logs.length === 0
		? '<span style="opacity:0.4">No output.</span>'
		: logs.map(l => `<div class="line">${esc(l)}</div>`).join('');

	return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
${SHARED_STYLE}
body { padding:28px 32px; height:100vh; display:flex; flex-direction:column; gap:16px; }
.header { display:flex; align-items:center; gap:14px; }
.icon {
  width:22px; height:22px; flex-shrink:0; border-radius:50%;
  background:#e74c3c; color:#fff;
  display:flex; align-items:center; justify-content:center;
  font-size:13px; font-weight:700; line-height:1;
}
.title { font-size:15px; font-weight:500; color:#e74c3c; }
.log {
  flex:1; overflow-y:auto;
  background:#0a0a14; border:1px solid #3a1a1a; border-radius:6px;
  padding:10px 14px;
  font-family:'SF Mono','Fira Code','Cascadia Code',monospace;
  font-size:11.5px; line-height:1.75; color:#c09090;
}
.line { white-space:pre-wrap; word-break:break-all; }
</style></head>
<body>
<div class="header">
  <div class="icon">✕</div>
  <div class="title">Failed to start Slidev</div>
</div>
<div class="log" id="log">${logContent}</div>
<script>var el=document.getElementById('log');if(el)el.scrollTop=el.scrollHeight;</script>
</body></html>`;
};

const readyHtml = (port: number, logs: string[]) => {
	const logContent = logs.length === 0
		? '<span style="opacity:0.4">No output yet…</span>'
		: logs.map(l => `<div class="line">${esc(l)}</div>`).join('');

	return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
${SHARED_STYLE}
body { padding:28px 32px; height:100vh; display:flex; flex-direction:column; gap:16px; }
.header { display:flex; align-items:center; gap:14px; }
.check {
  width:22px; height:22px; flex-shrink:0; border-radius:50%;
  background:#42b883; color:#12121e;
  display:flex; align-items:center; justify-content:center;
  font-size:13px; font-weight:700;
}
.title { font-size:15px; font-weight:500; }
.url {
  font-family:'SF Mono','Fira Code','Cascadia Code',monospace;
  font-size:12px; color:#42b883; margin-top:3px;
}
.log {
  flex:1; overflow-y:auto;
  background:#0a0a14; border:1px solid #1e1e30; border-radius:6px;
  padding:10px 14px;
  font-family:'SF Mono','Fira Code','Cascadia Code',monospace;
  font-size:11.5px; line-height:1.75; color:#7ec89a;
}
.line { white-space:pre-wrap; word-break:break-all; }
</style></head>
<body>
<div class="header">
  <div class="check">✓</div>
  <div>
    <div class="title">Slidev is running</div>
    <div class="url">http://localhost:${port}/</div>
  </div>
</div>
<div class="log" id="log">${logContent}</div>
<script>var el=document.getElementById('log');if(el)el.scrollTop=el.scrollHeight;</script>
</body></html>`;
};


const slidevUrl = (port: number, view: string): string => {
	if (view === 'presenter') return `http://localhost:${port}/presenter`;
	if (view === 'overview') return `http://localhost:${port}/overview`;
	return `http://localhost:${port}`;
};

// ---------- dialog handle ----------

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
				{ id: 'open-browser', title: 'Open in Browser' },
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

	// Open dialog — loop so "Open in Browser" re-opens without closing.
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

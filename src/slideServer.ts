import { spawn, ChildProcess } from 'child_process';
import { writeFile, mkdir, readFile, unlink, access, readdir } from 'fs/promises';
import { unlinkSync } from 'fs';
import { join } from 'path';
import * as net from 'net';

export interface SlidevServer {
	process: ChildProcess;
	port: number;
	workDir: string;
	dataDir: string;
}

export interface SlidevRemoteOptions {
	remoteAccess: boolean;
	remotePassword: string;
	remoteTunnel: boolean;
	remoteBind: string;
}

export interface InstalledSlidevTheme {
	name: string;
	packageName: string;
}

export interface InstalledSlidevPackage {
	packageName: string;
	version: string;
}

// ---------- port helpers ----------

const isPortAvailable = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => { server.close(); resolve(true); });
		server.listen(port, '127.0.0.1');
	});

export const findAvailablePort = async (startPort: number): Promise<number> => {
	for (let port = startPort; port <= startPort + 100; port++) {
		if (await isPortAvailable(port)) return port;
	}
	throw new Error(`No free port in range ${startPort}–${startPort + 100}`);
};

export const waitForServerReady = (port: number, timeoutMs = 60000): Promise<boolean> =>
	new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const tryConnect = () => {
			const sock = new net.Socket();
			sock.setTimeout(500);
			const onFail = () => {
				sock.destroy();
				Date.now() >= deadline ? resolve(false) : setTimeout(tryConnect, 500);
			};
			sock.on('connect', () => { sock.destroy(); resolve(true); });
			sock.on('error', onFail);
			sock.on('timeout', onFail);
			sock.connect(port, '127.0.0.1');
		};
		tryConnect();
	});

// ---------- PID file (crash-recovery) ----------

const PID_FILE_PREFIX = 'slidev-server-';
const PID_FILE_SUFFIX = '.pid';
const LEGACY_PID_FILE = 'slidev-server.pid';

const pidFileName = (pid: number) => `${PID_FILE_PREFIX}${pid}${PID_FILE_SUFFIX}`;

const writePidFile = async (dataDir: string, pid: number) =>
	writeFile(join(dataDir, pidFileName(pid)), String(pid), 'utf-8');

const removePidFileSync = (dataDir: string, pid: number | undefined) => {
	if (!pid) return;
	try { unlinkSync(join(dataDir, pidFileName(pid))); } catch { /* already gone */ }
};

/** Call once at plugin startup to kill any server left over from a previous crash. */
export const cleanupOrphanedServer = async (dataDir: string): Promise<void> => {
	try {
		const entries = await readdir(dataDir);
		const pidFiles = entries.filter(name =>
			(name.startsWith(PID_FILE_PREFIX) && name.endsWith(PID_FILE_SUFFIX)) || name === LEGACY_PID_FILE,
		);
		for (const pidFile of pidFiles) {
			const raw = await readFile(join(dataDir, pidFile), 'utf-8');
			const pid = parseInt(raw.trim(), 10);
			if (!pid || isNaN(pid)) continue;

			try {
				// Negative PID targets the whole process group.
				process.platform !== 'win32'
					? process.kill(-pid, 'SIGKILL')
					: process.kill(pid, 'SIGKILL');
				console.log(`[Slidev] Cleaned up orphaned server process group ${pid}`);
			} catch {
				// ESRCH = process already dead; either way we're fine.
			}

			await unlink(join(dataDir, pidFile)).catch(() => {/* ignore */});
		}
	} catch {
		// Data dir or PID files do not exist → nothing to clean up.
	}
};

// ---------- process-exit cleanup (daemon behaviour) ----------

// All currently running servers tracked at module level so exit handlers can reach them.
const activeServers = new Set<SlidevServer>();
let cleanupRegistered = false;

const killServerSync = (server: SlidevServer) => {
	const pid = server.process.pid;
	if (!pid) return;
	try {
		process.platform !== 'win32'
			? process.kill(-pid, 'SIGKILL')
			: server.process.kill('SIGKILL');
	} catch { /* already dead */ }
};

/** Synchronous cleanup: called from 'exit' (must be sync) and signal handlers. */
const syncKillAll = (dataDir: string) => {
	for (const srv of activeServers) {
		killServerSync(srv);
		removePidFileSync(dataDir, srv.process.pid);
	}
	activeServers.clear();
};

/**
 * Register process-level exit and signal hooks the first time a server is started.
 * This ensures Slidev is always torn down when Joplin exits — even on SIGTERM/SIGINT,
 * while still allowing Joplin's own handlers to run afterwards.
 */
const registerProcessCleanup = (dataDir: string) => {
	if (cleanupRegistered) return;
	cleanupRegistered = true;

	// 'exit' fires on clean process.exit() calls — must be synchronous.
	process.on('exit', () => syncKillAll(dataDir));

	// For OS signals: clean up, remove ourselves, then re-raise so Node's
	// default behaviour (and any other handlers) can still run.
	for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
		const handler = () => {
			syncKillAll(dataDir);
			process.removeListener(sig, handler);
			process.kill(process.pid, sig); // re-raise → default termination
		};
		process.on(sig, handler);
	}
};

// ---------- child-process environment ----------

export const buildChildEnv = (): NodeJS.ProcessEnv => {
	const extraPaths = [
		'/usr/local/bin',
		'/opt/homebrew/bin',
		`${process.env['HOME'] ?? ''}/.nvm/versions/node/current/bin`,
		`${process.env['HOME'] ?? ''}/.volta/bin`,
		`${process.env['HOME'] ?? ''}/.fnm/current/bin`,
	].join(':');

	// Strip Electron-specific NODE_OPTIONS flags (e.g. --localstorage-file) that
	// Joplin injects and that plain Node.js doesn't recognise, causing spurious warnings.
	const cleanNodeOptions = (process.env['NODE_OPTIONS'] ?? '')
		.split(/\s+/)
		.filter(f => f && !f.startsWith('--localstorage-'))
		.join(' ') || undefined;

	return {
		...process.env,
		PATH: `${extraPaths}:${process.env['PATH'] ?? ''}`,
		NODE_OPTIONS: cleanNodeOptions,
	};
};

// ---------- version helpers ----------

const SLIDEV_WORK_DIR = 'slidev-workspace';

export const slidevWorkspaceDir = (dataDir: string): string => join(dataDir, SLIDEV_WORK_DIR);

export const readInstalledSlidevVersion = async (dataDir: string): Promise<string | null> => {
	try {
		const raw = await readFile(
			join(dataDir, SLIDEV_WORK_DIR, 'node_modules', '@slidev', 'cli', 'package.json'),
			'utf-8',
		);
		const pkg = JSON.parse(raw);
		return typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
};

const themeNameFromPackage = (packageName: string): string | null => {
	if (packageName.startsWith('@slidev/theme-')) return packageName.slice('@slidev/theme-'.length);
	if (packageName.startsWith('slidev-theme-')) return packageName.slice('slidev-theme-'.length);

	const scopedThemeMatch = packageName.match(/^(@[^/]+)\/slidev-theme-(.+)$/);
	if (scopedThemeMatch) return `${scopedThemeMatch[1]}/${scopedThemeMatch[2]}`;

	return null;
};

const readPackageName = async (packageDir: string): Promise<string | null> => {
	try {
		const raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		return typeof pkg.name === 'string' ? pkg.name : null;
	} catch {
		return null;
	}
};

const readPackageInfo = async (packageDir: string): Promise<{ name: string; version: string } | null> => {
	try {
		const raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		return typeof pkg.name === 'string'
			? { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '' }
			: null;
	} catch {
		return null;
	}
};

const isSlidevThemePackageName = (packageName: string) =>
	packageName.startsWith('@slidev/theme-')
	|| packageName.startsWith('slidev-theme-')
	|| /^@[^/]+\/slidev-theme-.+$/.test(packageName);

const isSlidevAddonPackageName = (packageName: string) =>
	packageName.startsWith('@slidev/addon-')
	|| packageName.startsWith('slidev-addon-')
	|| /^@[^/]+\/slidev-addon-.+$/.test(packageName);

export const listInstalledSlidevThemes = async (dataDir: string): Promise<InstalledSlidevTheme[]> => {
	const nodeModulesDir = join(slidevWorkspaceDir(dataDir), 'node_modules');
	const themes = new Map<string, InstalledSlidevTheme>();

	try {
		const entries = await readdir(nodeModulesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			if (entry.name.startsWith('@')) {
				const scopeDir = join(nodeModulesDir, entry.name);
				const scopedEntries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
				for (const scopedEntry of scopedEntries) {
					if (!scopedEntry.isDirectory()) continue;
					const packageDir = join(scopeDir, scopedEntry.name);
					const packageName = await readPackageName(packageDir) ?? `${entry.name}/${scopedEntry.name}`;
					const name = themeNameFromPackage(packageName);
					if (name) themes.set(name, { name, packageName });
				}
				continue;
			}

			const packageDir = join(nodeModulesDir, entry.name);
			const packageName = await readPackageName(packageDir) ?? entry.name;
			const name = themeNameFromPackage(packageName);
			if (name) themes.set(name, { name, packageName });
		}
	} catch {
		return [];
	}

	return [...themes.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const listInstalledSlidevPackages = async (dataDir: string, kind: 'theme' | 'addon'): Promise<InstalledSlidevPackage[]> => {
	const nodeModulesDir = join(slidevWorkspaceDir(dataDir), 'node_modules');
	const packages = new Map<string, InstalledSlidevPackage>();
	const matchesKind = kind === 'theme' ? isSlidevThemePackageName : isSlidevAddonPackageName;

	try {
		const entries = await readdir(nodeModulesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			if (entry.name.startsWith('@')) {
				const scopeDir = join(nodeModulesDir, entry.name);
				const scopedEntries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
				for (const scopedEntry of scopedEntries) {
					if (!scopedEntry.isDirectory()) continue;
					const info = await readPackageInfo(join(scopeDir, scopedEntry.name));
					if (info && matchesKind(info.name)) packages.set(info.name, { packageName: info.name, version: info.version });
				}
				continue;
			}

			const info = await readPackageInfo(join(nodeModulesDir, entry.name));
			if (info && matchesKind(info.name)) packages.set(info.name, { packageName: info.name, version: info.version });
		}
	} catch {
		return [];
	}

	return [...packages.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
};

// ---------- project setup ----------

// Minimal package.json written into the work dir so Slidev can resolve themes
// from a local node_modules rather than prompting to download them at runtime.
const WORK_DIR_PACKAGE_JSON = JSON.stringify({
	name: 'joplin-slidev-presentation',
	private: true,
	dependencies: {
		'@slidev/cli': 'latest',
		'@slidev/theme-default': 'latest',
		'@slidev/theme-seriph': 'latest',
	},
}, null, 2);

const runNpmInstallPackage = (
	workDir: string,
	packages: string | string[],
	emit: (line: string) => void,
): Promise<void> => {
	const pkgs = Array.isArray(packages) ? packages : [packages];
	return new Promise((resolve, reject) => {
		const proc = spawn('npm', ['install', ...pkgs, '--no-audit', '--no-fund'], {
			cwd: workDir,
			env: buildChildEnv(),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const onData = (d: Buffer) =>
			d.toString().split('\n').map(l => l.trimEnd()).filter(Boolean).forEach(emit);
		proc.stdout?.on('data', onData);
		proc.stderr?.on('data', onData);
		proc.on('error', reject);
		proc.on('close', (code) =>
			code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`)),
		);
	});
};

const ensurePlaywrightChromium = async (workDir: string, emit: (line: string) => void) => {
	const packagePath = join(workDir, 'node_modules', 'playwright-chromium', 'package.json');
	const needsInstall = await access(packagePath).then(() => false).catch(() => true);
	if (!needsInstall) return;
	emit('Installing playwright-chromium for Slidev CLI export...');
	emit('(This is required by Slidev export and may take a while once.)');
	await runNpmInstallPackage(workDir, 'playwright-chromium', emit);
	emit('playwright-chromium install complete.');
};

const isSlidevPackageName = (packageName: string) =>
	/^(?:@[^/]+\/)?(?:slidev-theme-|slidev-addon-|theme-|addon-)[a-z0-9._-]+$/.test(packageName)
	|| /^@slidev\/(?:theme|addon)-[a-z0-9._-]+$/.test(packageName);

export const installSlidevPackage = (
	dataDir: string,
	packageName: string,
	emit: (line: string) => void,
): Promise<void> => {
	if (!isSlidevPackageName(packageName)) throw new Error(`Not a Slidev theme/addon package: ${packageName}`);

	return runNpmInstallPackage(slidevWorkspaceDir(dataDir), `${packageName}@latest`, emit);
};

export const updateSlidevCore = (dataDir: string, emit: (line: string) => void): Promise<void> =>
	runNpmInstallPackage(
		slidevWorkspaceDir(dataDir),
		['@slidev/cli@latest', '@slidev/theme-default@latest'],
		emit,
	);

const prepareSlideshowDir = async (
	markdown: string,
	dataDir: string,
	emit: (line: string) => void,
	preprocessMarkdown?: (md: string, workDir: string) => Promise<string>,
	extraFiles?: Record<string, string>,
): Promise<{ workDir: string; slidevBin: string }> => {
	const workDir = slidevWorkspaceDir(dataDir);
	await mkdir(workDir, { recursive: true });
	const processedMarkdown = preprocessMarkdown
		? await preprocessMarkdown(markdown, workDir)
		: markdown;
	await writeFile(join(workDir, 'slides.md'), processedMarkdown, 'utf-8');
	if (extraFiles) {
		for (const [relativePath, content] of Object.entries(extraFiles)) {
			const fullPath = join(workDir, relativePath);
			await mkdir(join(fullPath, '..'), { recursive: true });
			await writeFile(fullPath, content, 'utf-8');
		}
	}

	// Check whether the local Slidev binary already exists.
	const slidevBin = join(workDir, 'node_modules', '.bin', 'slidev');
	const needsInstall = await access(slidevBin).then(() => false).catch(() => true);

	if (needsInstall) {
		await writeFile(join(workDir, 'package.json'), WORK_DIR_PACKAGE_JSON, 'utf-8');
		emit('First-time setup: installing @slidev/cli and themes via npm…');
		emit('(This takes ~30 s once; subsequent starts are instant.)');
		await runNpmInstallPackage(workDir, [], emit);
		emit('npm install complete.');
	}

	return { workDir, slidevBin };
};

// ---------- public API ----------

export const startSlidevServer = async (
	markdown: string,
	dataDir: string,
	port: number,
	onLog?: (line: string) => void,
	preprocessMarkdown?: (md: string, workDir: string) => Promise<string>,
	extraFiles?: Record<string, string>,
	remoteOptions?: SlidevRemoteOptions,
): Promise<SlidevServer> => {
	registerProcessCleanup(dataDir);

	const env = buildChildEnv();

	const emit = (line: string) => {
		console.log('[Slidev]', line);
		onLog?.(line);
	};

	const { workDir, slidevBin } = await prepareSlideshowDir(markdown, dataDir, emit, preprocessMarkdown, extraFiles);

	const cmd = slidevBin;
	const args = ['slides.md', '--port', String(port), '--no-open'];
	const remotePassword = remoteOptions?.remotePassword.trim() ?? '';
	const remoteBind = remoteOptions?.remoteBind.trim() ?? '';
	const remoteEnabled = Boolean(remoteOptions?.remoteAccess || remotePassword || remoteOptions?.remoteTunnel);
	if (remotePassword) args.push(`--remote=${remotePassword}`);
	else if (remoteEnabled) args.push('--remote');
	if (remoteEnabled && remoteBind) args.push('--bind', remoteBind);
	if (remoteOptions?.remoteTunnel) args.push('--tunnel');
	const displayArgs = args.map(arg => arg.startsWith('--remote=') ? '--remote=********' : arg);

	emit(`Starting: ${cmd} ${displayArgs.join(' ')}`);

	const proc = spawn(cmd, args, {
		cwd: workDir,
		shell: process.platform === 'win32',
		env,
		// New process group so we can kill the entire tree with -pid.
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	// Attach log handlers BEFORE the spawnError check so no output is missed.
	const handleData = (d: Buffer) => {
		for (const line of d.toString().split('\n')) {
			const trimmed = line.trimEnd();
			if (trimmed) emit(trimmed);
		}
	};
	proc.stdout?.on('data', handleData);
	proc.stderr?.on('data', handleData);

	// Detect immediate spawn failures (ENOENT = command not found).
	const spawnError = await new Promise<Error | null>((resolve) => {
		let done = false;
		proc.once('error', (err) => { if (!done) { done = true; resolve(err); } });
		setTimeout(() => { if (!done) { done = true; resolve(null); } }, 400);
	});

	if (spawnError) {
		const isNotFound = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
		const hint = isNotFound
			? `\n\nThe local Slidev binary was not found. Try restarting Joplin or reinstalling the plugin dependencies.`
			: '';
		throw new Error(spawnError.message + hint);
	}

	// Unref so Joplin's event loop is not held open waiting for this child.
	// The exit/signal handlers above will still kill it when Joplin goes down.
	if (process.platform !== 'win32') proc.unref();

	const server: SlidevServer = { process: proc, port, workDir, dataDir };
	activeServers.add(server);

	// Persist PID so a crash-recovery cleanup on next startup can find it.
	if (proc.pid) await writePidFile(dataDir, proc.pid);

	return server;
};

export const stopSlidevServer = (server: SlidevServer): void => {
	killServerSync(server);
	activeServers.delete(server);
	removePidFileSync(server.dataDir, server.process.pid);
};

export const exportSlidevDeck = async (
	markdown: string,
	dataDir: string,
	format: 'pdf' | 'pptx' | 'png' | 'md',
	outputPath: string,
	onLog?: (line: string) => void,
	preprocessMarkdown?: (md: string, workDir: string) => Promise<string>,
	extraFiles?: Record<string, string>,
): Promise<string> => {
	const env = buildChildEnv();
	const emit = (line: string) => {
		console.log('[Slidev]', line);
		onLog?.(line);
	};
	const { workDir, slidevBin } = await prepareSlideshowDir(markdown, dataDir, emit, preprocessMarkdown, extraFiles);
	await ensurePlaywrightChromium(workDir, emit);

	const args = ['export', 'slides.md', '--format', format, '--output', outputPath];
	emit(`Exporting: ${slidevBin} ${args.join(' ')}`);

	await new Promise<void>((resolve, reject) => {
		const proc = spawn(slidevBin, args, {
			cwd: workDir,
			shell: process.platform === 'win32',
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const handleData = (d: Buffer) => {
			for (const line of d.toString().split('\n')) {
				const trimmed = line.trimEnd();
				if (trimmed) onLog?.(trimmed);
			}
		};
		proc.stdout?.on('data', handleData);
		proc.stderr?.on('data', handleData);
		proc.on('error', reject);
		proc.on('close', (code) => {
			code === 0 ? resolve() : reject(new Error(`Slidev export exited with code ${code}`));
		});
	});

	emit(`Export complete: ${outputPath}`);
	return outputPath;
};

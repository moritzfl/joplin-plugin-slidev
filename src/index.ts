import joplin from 'api';
import { ContentScriptType, MenuItemLocation, ToolbarButtonLocation } from 'api/types';
import { mkdir } from 'fs/promises';
import { pluginPrefix } from './constants';
import { registerSettings, getSettings, openSlidevWorkspaceKey, workspacePathKey } from './settings';
import { cleanupOrphanedServer, listInstalledSlidevThemes, slidevWorkspaceDir } from './slideServer';
import { showSlidevPresentation } from './dialog/SlidevDialog';
import { showSlidevPackageDialog } from './dialog/SlidevPackageDialog';
import { registerSlidevExportModules } from './exporter/registerExportModules';

// electron is available at runtime inside Joplin (Electron app) but has no bundled types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shell } = require('electron') as { shell: { openPath: (path: string) => Promise<string> } };

const startPresentation = async () => {
	const note = await joplin.workspace.selectedNote();
	if (!note) {
		await joplin.views.dialogs.showMessageBox('Please select a note first.');
		return;
	}

	const markdown: string = (note as any).body ?? '';
	if (!markdown.trim()) {
		await joplin.views.dialogs.showMessageBox('The selected note is empty.');
		return;
	}

	const settings = await getSettings();
	const dataDir = await joplin.plugins.dataDir();

	await showSlidevPresentation(markdown, settings, dataDir);
};

const openSlidevWorkspace = async () => {
	const dataDir = await joplin.plugins.dataDir();
	const workspaceDir = slidevWorkspaceDir(dataDir);
	await mkdir(workspaceDir, { recursive: true });

	const error = await shell.openPath(workspaceDir);
	if (error) throw new Error(`Could not open Slidev workspace:\n${workspaceDir}\n\n${error}`);
};

const manageSlidevPackages = async () => {
	const dataDir = await joplin.plugins.dataDir();
	await showSlidevPackageDialog(dataDir);
};

const showPluginError = async (context: string, error: unknown) => {
	console.error(`[Slidev] ${context}:`, error);
	try {
		await joplin.views.dialogs.showMessageBox(
			`Slidev plugin error:\n${(error as Error).message ?? String(error)}`,
		);
	} catch {
		// If even showMessageBox fails, there is nothing more we can do.
	}
};

joplin.plugins.register({
	onStart: async () => {
		// Kill any Slidev server left running from a previous Joplin crash.
		const dataDir = await joplin.plugins.dataDir();
		await cleanupOrphanedServer(dataDir);

		await registerSettings(slidevWorkspaceDir(dataDir), await listInstalledSlidevThemes(dataDir));
		await registerSlidevExportModules();

		const commandName = `${pluginPrefix}start-presentation`;
		await joplin.commands.register({
			name: commandName,
			label: 'Start Slidev Presentation',
			iconName: 'fas fa-play-circle',
			execute: async () => {
				try {
					await startPresentation();
				} catch (e) {
					await showPluginError('Unhandled error in startPresentation', e);
				}
			},
		});

		const openWorkspaceCommandName = `${pluginPrefix}open-slidev-workspace`;
		await joplin.commands.register({
			name: openWorkspaceCommandName,
			label: 'Open Slidev Workspace',
			iconName: 'fas fa-folder-open',
			execute: async () => {
				try {
					await openSlidevWorkspace();
				} catch (e) {
					await showPluginError('Unhandled error in openSlidevWorkspace', e);
				}
			},
		});

		const managePackagesCommandName = `${pluginPrefix}manage-slidev-packages`;
		await joplin.commands.register({
			name: managePackagesCommandName,
			label: 'Manage Slidev Themes/Addons',
			iconName: 'fas fa-puzzle-piece',
			execute: async () => {
				try {
					await manageSlidevPackages();
				} catch (e) {
					await showPluginError('Unhandled error in manageSlidevPackages', e);
				}
			},
		});

		await joplin.settings.onChange(async (event) => {
			if (event.keys.includes(workspacePathKey)) {
				const workspaceDir = slidevWorkspaceDir(dataDir);
				if (await joplin.settings.value(workspacePathKey) !== workspaceDir) {
					await joplin.settings.setValue(workspacePathKey, workspaceDir);
				}
			}

			if (event.keys.includes(openSlidevWorkspaceKey)) {
				try {
					await openSlidevWorkspace();
				} catch (e) {
					await showPluginError('Unhandled error in openSlidevWorkspace setting', e);
				}
			}
		});

		const settings = await getSettings();
		if (!settings.disableFrontmatterRenderer) {
			await joplin.contentScripts.register(
				ContentScriptType.MarkdownItPlugin,
				'slidev-frontmatter-renderer',
				'./frontmatterRenderer.js',
			);
		}
		if (!settings.hideToolbarButton) {
			await joplin.views.toolbarButtons.create(
				commandName,
				commandName,
				ToolbarButtonLocation.NoteToolbar,
			);
		}

		await joplin.views.menuItems.create(
			`${pluginPrefix}startPresentationMenu`,
			commandName,
			MenuItemLocation.View,
		);

		await joplin.views.menuItems.create(
			`${pluginPrefix}openSlidevWorkspaceMenu`,
			openWorkspaceCommandName,
			MenuItemLocation.View,
		);

		await joplin.views.menuItems.create(
			`${pluginPrefix}manageSlidevPackagesMenu`,
			managePackagesCommandName,
			MenuItemLocation.Tools,
		);
	},
});

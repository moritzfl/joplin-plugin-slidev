import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const port = process.env.JOPLIN_DEBUG_PORT || '9222';
const browserURL = process.env.JOPLIN_CDP_URL || `http://127.0.0.1:${port}`;
const action = process.argv[2] || 'list';
const targetQuery = process.argv[3] || '';

const usage = () => {
	console.log(`Usage:
  npm run puppeteer:joplin -- list
  npm run puppeteer:joplin -- pages
  npm run puppeteer:joplin -- console [target-title-or-url-substring]
  npm run puppeteer:joplin -- screenshot [target-title-or-url-substring] [output-path]

Environment:
  JOPLIN_DEBUG_PORT=9222
  JOPLIN_CDP_URL=http://127.0.0.1:9222
`);
};

const connect = async () => puppeteer.connect({ browserURL, defaultViewport: null });

const pageLabel = async (page) => {
	const title = await page.title().catch(() => '');
	const url = page.url();
	return { title, url };
};

const findPage = async (browser, query) => {
	const pages = await browser.pages();
	if (!query) return pages[0];
	for (const page of pages) {
		const { title, url } = await pageLabel(page);
		if (title.includes(query) || url.includes(query)) return page;
	}
	throw new Error(`No page matched query: ${query}`);
};

const listTargets = async (browser) => {
	for (const target of browser.targets()) {
		console.log(`${target.type()}\t${target.url() || '(no url)'}`);
	}
};

const listPages = async (browser) => {
	const pages = await browser.pages();
	for (let i = 0; i < pages.length; i++) {
		const { title, url } = await pageLabel(pages[i]);
		console.log(`[${i}] ${title || '(untitled)'}`);
		console.log(`    ${url}`);
	}
};

const captureConsole = async (browser, query) => {
	const page = await findPage(browser, query);
	const { title, url } = await pageLabel(page);
	console.log(`Listening for console output from: ${title || '(untitled)'}`);
	console.log(url);

	page.on('console', async (message) => {
		const args = await Promise.all(message.args().map(async (arg) => {
			try {
				return await arg.jsonValue();
			} catch {
				return arg.toString();
			}
		}));
		console.log(`[${message.type()}]`, ...args);
	});

	await new Promise(resolve => setTimeout(resolve, 10000));
};

const screenshot = async (browser, query, outputPath) => {
	const page = await findPage(browser, query);
	const path = resolve(outputPath || 'tmp/joplin-debug-screenshot.png');
	await mkdir(dirname(path), { recursive: true });
	await page.screenshot({ path, fullPage: true });
	console.log(path);
};

let browser;
try {
	browser = await connect();
	if (action === 'list') await listTargets(browser);
	else if (action === 'pages') await listPages(browser);
	else if (action === 'console') await captureConsole(browser, targetQuery);
	else if (action === 'screenshot') await screenshot(browser, targetQuery, process.argv[4]);
	else {
		usage();
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`Could not connect to ${browserURL}`);
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await browser?.disconnect();
}

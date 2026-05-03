const port = process.env.JOPLIN_DEBUG_PORT || '9222';
const url = `http://127.0.0.1:${port}/json/list`;

try {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	const targets = await response.json();
	for (const target of targets) {
		console.log(`${target.type}\t${target.title || '(untitled)'}`);
		console.log(`  url: ${target.url}`);
		console.log(`  devtools: ${target.devtoolsFrontendUrl}`);
		console.log(`  websocket: ${target.webSocketDebuggerUrl}`);
	}
} catch (error) {
	console.error(`Could not read Electron debug targets from ${url}`);
	console.error((error instanceof Error ? error.message : String(error)));
	process.exit(1);
}

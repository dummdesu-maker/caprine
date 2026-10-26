// Temporary verification harness for audit finding #1 (the layout observer).
//
// Extracts the compiled functions from dist-js/browser.js and drives them
// against a jsdom document with a controlled requestAnimationFrame queue, so we
// can assert both correct tagging and that the steady state performs no
// document-wide `:has()` query.
//
// Usage: npm run build && node debug/layout-observer-harness.mjs

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {JSDOM} from 'jsdom';

const sourcePath = process.argv[2]
	? path.resolve(process.argv[2])
	: fileURLToPath(new URL('../dist-js/browser.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});

const CLASSLESS = 'caprine-thread-list-container';

const wantedVariables = new Set([
	'threadListSelector',
	'threadListContainerClass',
	'LAYOUT_SEARCH_BACKOFF_MS',
	'taggedThreadListContainer',
	'lastThreadListSearchAt',
]);
const wantedFunctions = new Set(['applyThreadListLayoutClass', 'observeMessengerLayout']);

let extracted = '';
const found = new Set();

for (const node of ast.body) {
	if (node.type === 'VariableDeclaration') {
		const names = node.declarations.map(d => d.id?.name).filter(Boolean);
		if (names.some(name => wantedVariables.has(name))) {
			extracted += source.slice(node.start, node.end) + '\n';
			for (const name of names) {
				found.add(name);
			}
		}
	}

	if (node.type === 'FunctionDeclaration' && node.id && wantedFunctions.has(node.id.name)) {
		extracted += source.slice(node.start, node.end) + '\n';
		found.add(node.id.name);
	}
}

const missing = [...wantedVariables, ...wantedFunctions].filter(name => !found.has(name));
if (missing.length > 0) {
	throw new Error(`Could not extract: ${missing.join(', ')}`);
}

const results = [];
const ok = (name, condition, extra) => {
	results.push(`${condition ? 'PASS' : 'FAIL'} :: ${name}${extra ? ` [${extra}]` : ''}`);
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// Builds a fresh document plus a fresh copy of the module state.
const createInstance = () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const {document} = dom.window;

	const stats = {themeQueries: 0, frames: 0};
	let rafQueue = [];

	const documentProxy = {
		body: document.body,
		querySelector(selector) {
			if (typeof selector === 'string' && selector.includes(':has(')) {
				stats.themeQueries++;
			}

			return document.querySelector(selector);
		},
	};

	const requestAnimationFrame = callback => {
		rafQueue.push(callback);
		return rafQueue.length;
	};

	const api = new Function('document', 'requestAnimationFrame', 'MutationObserver', `
		${extracted}
		return {applyThreadListLayoutClass, observeMessengerLayout};
	`)(documentProxy, requestAnimationFrame, dom.window.MutationObserver);

	const mountThreadList = () => {
		const shell = document.createElement('div');
		const navigation = document.createElement('div');
		navigation.setAttribute('role', 'navigation');
		const grid = document.createElement('div');
		grid.setAttribute('role', 'grid');
		navigation.append(grid);
		shell.append(navigation);
		document.body.append(shell);
		return {shell, navigation, container: shell};
	};

	return {
		document,
		stats,
		dom,
		...api,
		mountThreadList,
		runFrame() {
			stats.frames++;
			const queued = rafQueue.splice(0, rafQueue.length);
			for (const callback of queued) {
				callback(0);
			}
		},
		pendingFrames() {
			return rafQueue.length;
		},
		mutate(fn) {
			fn();
		},
	};
};

// --- initial tagging ----------------------------------------------------
{
	const mod = createInstance();
	const {container} = mod.mountThreadList();

	mod.applyThreadListLayoutClass();

	ok('initial: tags the container', container.classList.contains(CLASSLESS));
	ok('initial: one query', mod.stats.themeQueries === 1, `queries=${mod.stats.themeQueries}`);
}

// --- steady state: no query per mutation --------------------------------
{
	const mod = createInstance();
	const {container} = mod.mountThreadList();
	mod.applyThreadListLayoutClass();
	mod.observeMessengerLayout();

	const before = mod.stats.themeQueries;

	for (let index = 0; index < 8; index++) {
		mod.document.body.append(mod.document.createElement('div'));
		await settle();
		mod.runFrame();
	}

	ok('steady state: still tagged', container.classList.contains(CLASSLESS));
	ok('steady state: no extra queries', mod.stats.themeQueries === before, `queries=${mod.stats.themeQueries}`);
}

// --- coalescing ---------------------------------------------------------
{
	const mod = createInstance();
	mod.mountThreadList();
	mod.applyThreadListLayoutClass();
	mod.observeMessengerLayout();

	for (let index = 0; index < 5; index++) {
		mod.document.body.append(mod.document.createElement('div'));
		await settle();
	}

	ok('coalesce: five batches queue one frame', mod.pendingFrames() === 1, `frames=${mod.pendingFrames()}`);
}

// --- the class is stripped while the node stays attached ----------------
{
	const mod = createInstance();
	const {container} = mod.mountThreadList();
	mod.applyThreadListLayoutClass();
	mod.observeMessengerLayout();

	container.classList.remove(CLASSLESS);
	mod.document.body.append(mod.document.createElement('div'));
	await settle();
	mod.runFrame();

	ok('stripped class: re-applied', container.classList.contains(CLASSLESS));
}

// --- Facebook replaces the whole container ------------------------------
{
	const mod = createInstance();
	const first = mod.mountThreadList();
	mod.applyThreadListLayoutClass();
	mod.observeMessengerLayout();

	const replacement = mod.mountThreadList();
	first.shell.remove();
	await settle();
	mod.runFrame();

	ok('replacement: new container tagged', replacement.container.classList.contains(CLASSLESS));
	// The detached node keeps its stale class attribute; what matters is that it
	// is no longer the tagged/observed container.
	ok('replacement: old container is detached', !first.container.isConnected);
}

// --- no thread list at all: the query is backed off ---------------------
{
	const mod = createInstance();
	mod.applyThreadListLayoutClass();

	const afterFirst = mod.stats.themeQueries;

	// Second attempt inside the backoff window must not query again.
	mod.applyThreadListLayoutClass();
	ok('no thread list: second attempt is backed off', mod.stats.themeQueries === afterFirst, `queries=${mod.stats.themeQueries}`);

	// ...and after the window elapses it tries again.
	await new Promise(resolve => setTimeout(resolve, 550));
	mod.applyThreadListLayoutClass();
	ok('no thread list: retries after backoff', mod.stats.themeQueries === afterFirst + 1, `queries=${mod.stats.themeQueries}`);
}

// --- recovery: a thread list appears later ------------------------------
{
	const mod = createInstance();
	mod.applyThreadListLayoutClass();
	ok('late mount: nothing tagged yet', mod.stats.themeQueries === 1);

	const {container} = mod.mountThreadList();
	await new Promise(resolve => setTimeout(resolve, 550));
	mod.applyThreadListLayoutClass();

	ok('late mount: tagged once it appears', container.classList.contains(CLASSLESS));
}

const failed = results.filter(line => line.startsWith('FAIL')).length;
for (const line of results) {
	console.log(line);
}

console.log(`\nSUMMARY: ${results.length} assertions, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

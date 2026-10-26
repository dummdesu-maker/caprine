// Temporary verification harness for audit finding #3 (icon cache + coalesced
// conversation-list scans).
//
// Extracts the compiled functions from dist-js/browser/conversation-list.js and
// runs them with stubbed collaborators, so cache hits/misses, the cache bound,
// and the "never run two scans at once" guarantee can be asserted directly.
//
// Usage: npm run build && node debug/conversation-list-harness.mjs

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {JSDOM} from 'jsdom';

const sourcePath = process.argv[2]
	? path.resolve(process.argv[2])
	: fileURLToPath(new URL('../dist-js/browser/conversation-list.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});

const wantedVariables = new Set(['icon', 'iconCache', 'MAX_CACHED_ICONS', 'listScheduled', 'listRunning', 'listDirty']);
const wantedFunctions = new Set(['getIcons', 'createIcons', 'getIcon', 'getLabel', 'scheduleConversationList', 'runConversationList']);

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

const required = [...wantedVariables, ...wantedFunctions];
const missing = required.filter(name => !found.has(name));
if (missing.length > 0) {
	throw new Error(`Could not extract: ${missing.join(', ')}`);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const {document} = dom.window;

// Builds a fresh instance of the module state with stubbed collaborators.
const createInstance = () => new Function('document', `
	const rafQueue = [];
	const requestAnimationFrame = callback => {
		rafQueue.push(callback);
		return rafQueue.length;
	};

	const state = {urlCalls: 0, sendCalls: 0, canvasSeq: 0, sendImpl: null};
	state.sendImpl = () => {
		state.sendCalls++;
		return Promise.resolve();
	};

	function makeCanvas(url) {
		const id = ++state.canvasSeq;
		let encodes = 0;
		return {
			width: 50,
			height: 56,
			getContext() {
				return {fillStyle: '', beginPath() {}, ellipse() {}, closePath() {}, fill() {}};
			},
			toDataURL() {
				encodes++;
				return 'data:image/png;base64,' + url + '-' + id + '-' + encodes;
			},
		};
	}

	function urlToCanvas(url) {
		state.urlCalls++;
		return Promise.resolve(makeCanvas(url));
	}

	function sendConversationList() {
		return state.sendImpl();
	}

	${extracted}

	return {
		getIcons,
		createIcons,
		getIcon,
		getLabel,
		iconCache,
		MAX_CACHED_ICONS,
		scheduleConversationList,
		runConversationList,
		state,
		runFrame() {
			const queued = rafQueue.splice(0, rafQueue.length);
			for (const callback of queued) {
				callback(0);
			}
		},
		pendingFrames() {
			return rafQueue.length;
		},
	};
`)(document);

const results = [];
const ok = (name, condition, extra) => {
	results.push(`${condition ? 'PASS' : 'FAIL'} :: ${name}${extra ? ` [${extra}]` : ''}`);
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// --- icon cache ---------------------------------------------------------
{
	const mod = createInstance();
	const first = await mod.getIcons('https://cdn/a.png');
	const second = await mod.getIcons('https://cdn/a.png');

	ok('cache: second lookup does not re-render', mod.state.urlCalls === 1, `urlCalls=${mod.state.urlCalls}`);
	ok('cache: returns the cached object', first === second);
	ok('cache: read and unread differ', first.read !== first.unread);
	ok('cache: read keeps the pre-marker encode', first.read.endsWith('-1'), first.read.slice(-24));
}

{
	const mod = createInstance();
	const a = await mod.getIcons('https://cdn/a.png');
	const b = await mod.getIcons('https://cdn/b.png');

	ok('cache: distinct URLs render separately', mod.state.urlCalls === 2, `urlCalls=${mod.state.urlCalls}`);
	ok('cache: distinct URLs yield distinct icons', a.read !== b.read);
}

{
	const mod = createInstance();
	const firstElement = document.createElement('img');
	const secondElement = document.createElement('img');
	await mod.createIcons(firstElement, 'https://cdn/a.png');
	await mod.createIcons(secondElement, 'https://cdn/a.png');

	ok('createIcons: sets both attributes',
		Boolean(firstElement.getAttribute('data-caprine-icon'))
		&& Boolean(firstElement.getAttribute('data-caprine-icon-unread')));
	ok('createIcons: second element reuses cache', mod.state.urlCalls === 1, `urlCalls=${mod.state.urlCalls}`);
	ok('createIcons: identical icons across elements',
		firstElement.getAttribute('data-caprine-icon') === secondElement.getAttribute('data-caprine-icon'));
	ok('createIcons: unread is the marked encode',
		firstElement.getAttribute('data-caprine-icon-unread').endsWith('-2'),
		firstElement.getAttribute('data-caprine-icon-unread').slice(-24));
}

{
	const mod = createInstance();
	for (let index = 0; index < 205; index++) {
		await mod.getIcons(`https://cdn/${index}.png`);
	}

	ok('cache: stays bounded', mod.iconCache.size === mod.MAX_CACHED_ICONS, `size=${mod.iconCache.size}`);
	ok('cache: evicts oldest first', !mod.iconCache.has('https://cdn/0.png'));
	ok('cache: keeps newest', mod.iconCache.has('https://cdn/204.png'));
}

// --- getIcon edge cases -------------------------------------------------
{
	const mod = createInstance();
	ok('getIcon: missing element yields empty string', await mod.getIcon(undefined, false) === '');
}

{
	// Lazy-loaded avatars: no `src` yet. Must not cache a placeholder.
	const mod = createInstance();
	const element = document.createElement('img');
	const result = await mod.getIcon(element, false);

	ok('getIcon: no src yields empty string', result === '');
	ok('getIcon: no src caches nothing', !element.getAttribute('data-caprine-icon'));
	ok('getIcon: no src renders nothing', mod.state.urlCalls === 0, `urlCalls=${mod.state.urlCalls}`);

	// ...and once Facebook fills in `src`, the next scan renders it.
	element.setAttribute('src', 'https://cdn/a.png');
	const later = await mod.getIcon(element, false);
	ok('getIcon: renders once src appears', later.startsWith('data:image/png'), later.slice(0, 24));
	ok('getIcon: renders after src appears', mod.state.urlCalls === 1, `urlCalls=${mod.state.urlCalls}`);
}

// --- getLabel must not mutate the live row ------------------------------
{
	const mod = createInstance();
	const labelElement = document.createElement('span');
	const emojiImage = document.createElement('img');
	emojiImage.setAttribute('alt', '👍');
	labelElement.append(emojiImage);

	const before = labelElement.innerHTML;
	const label = await mod.getLabel(labelElement);

	ok('getLabel: extracts emoji from alt', label === '👍', label);
	ok('getLabel: leaves the live DOM untouched', labelElement.innerHTML === before, labelElement.innerHTML);
}

// --- scan coalescing ----------------------------------------------------
{
	const mod = createInstance();
	mod.scheduleConversationList();
	mod.scheduleConversationList();
	mod.scheduleConversationList();

	ok('coalesce: three requests queue one frame', mod.pendingFrames() === 1, `frames=${mod.pendingFrames()}`);
	mod.runFrame();
	await settle();
	ok('coalesce: one scan per frame', mod.state.sendCalls === 1, `sendCalls=${mod.state.sendCalls}`);
}

{
	// First scan hangs until released, so a second request arrives mid-scan.
	const mod = createInstance();
	let releaseFirstScan;

	mod.state.sendImpl = () => {
		mod.state.sendCalls++;

		if (mod.state.sendCalls === 1) {
			return new Promise(resolve => {
				releaseFirstScan = resolve;
			});
		}

		return Promise.resolve();
	};

	mod.scheduleConversationList();
	mod.runFrame();
	await settle();
	ok('overlap: scan started', mod.state.sendCalls === 1, `sendCalls=${mod.state.sendCalls}`);

	mod.scheduleConversationList();
	mod.runFrame();
	await settle();
	ok('overlap: no second concurrent scan', mod.state.sendCalls === 1, `sendCalls=${mod.state.sendCalls}`);

	releaseFirstScan();
	await settle();
	ok('overlap: follow-up is deferred to a frame', mod.state.sendCalls === 1, `sendCalls=${mod.state.sendCalls}`);

	mod.runFrame();
	await settle();
	ok('overlap: catch-up scan runs after the first', mod.state.sendCalls === 2, `sendCalls=${mod.state.sendCalls}`);
}

const failed = results.filter(line => line.startsWith('FAIL')).length;
for (const line of results) {
	console.log(line);
}

console.log(`\nSUMMARY: ${results.length} assertions, ${failed} failed`);
dom.window.close();
process.exitCode = failed > 0 ? 1 : 0;

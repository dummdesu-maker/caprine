// Temporary verification harness for the theme-observer fix (audit finding #1).
//
// Extracts the *compiled* functions from dist-js/browser.js (never a
// re-implementation) and runs them inside a jsdom document with a controlled
// requestAnimationFrame queue, so coalescing, the bounded degrade, and class
// polarity can be asserted deterministically.
//
// Usage: node debug/theme-observer-harness.mjs
// Exits non-zero if any assertion fails.

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {JSDOM} from 'jsdom';

// Optional override so the same assertions can be run against another build
// (e.g. the pre-fix implementation) to prove the test discriminates.
const sourcePath = process.argv[2]
	? path.resolve(process.argv[2])
	: fileURLToPath(new URL('../dist-js/browser.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
console.log(`Source: ${sourcePath}\n`);
const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});

const required = ['removeThemeClasses', 'observeThemeBugs'];
// `removeThemeClassesFrom` only exists in the fixed implementation, so that the
// same assertions can also be run against the pre-fix build.
const optional = ['removeThemeClassesFrom'];
const wanted = new Set([...required, ...optional]);
const extracted = new Map();

for (const node of ast.body) {
	if (node.type === 'FunctionDeclaration' && node.id && wanted.has(node.id.name)) {
		extracted.set(node.id.name, source.slice(node.start, node.end));
	}
}

const missing = required.filter(name => !extracted.has(name));
if (missing.length > 0) {
	throw new Error(`Could not extract: ${missing.join(', ')}`);
}

const functions = [...extracted.values()].join('\n\n');

const testScript = String.raw`
(async () => {
	const results = [];
	const ok = (name, condition, extra) => {
		results.push((condition ? 'PASS' : 'FAIL') + ' :: ' + name + (extra ? ' [' + extra + ']' : ''));
	};

	// ---- controlled scheduler: rAF callbacks run only when the test says so ----
	let rafCalls = 0;
	let rafQueue = [];
	const requestAnimationFrame = callback => {
		rafCalls++;
		rafQueue.push(callback);
		return rafQueue.length;
	};
	const runFrame = () => {
		const queue = rafQueue;
		rafQueue = [];
		for (const callback of queue) {
			callback(0);
		}
	};
	const tick = () => new Promise(resolve => setTimeout(resolve, 0));

	const nativeTheme = {shouldUseDarkColors: true};  // dark mode -> stale class is __fb-light-mode
	// Compiled browser.ts reaches the Electron module through its import alias.
	const remote_1 = {nativeTheme};
	const STALE = '__fb-light-mode';

	const makeStale = (className = STALE) => {
		const element = document.createElement('div');
		element.className = className;
		return element;
	};

	// ---- real compiled implementations, injected verbatim ----
	${functions}

	await observeThemeBugs();

	// T1: stale class is stripped from an added node and its descendants.
	const t1root = makeStale();
	const t1inner = document.createElement('span');
	t1inner.className = STALE;
	t1root.append(t1inner);
	document.body.append(t1root);
	await tick();
	runFrame();
	ok('T1 cleans added root', !t1root.classList.contains(STALE));
	ok('T1 cleans added descendant', !t1inner.classList.contains(STALE));

	// T2: several mutation batches land in one frame -> a single rAF.
	rafCalls = 0;
	const t2nodes = [makeStale(), makeStale(), makeStale()];
	for (const node of t2nodes) {
		document.body.append(node);
		await tick();
	}
	ok('T2 coalesces 3 batches into 1 frame', rafCalls === 1, 'rafCalls=' + rafCalls);
	runFrame();
	ok('T2 cleans all coalesced nodes', t2nodes.every(n => !n.classList.contains(STALE)));

	// T3: documents the intentional narrowing. A class set directly on a
	// pre-existing node (attribute change, not observed) is not swept by the
	// scoped path; the old code only caught it incidentally via unrelated
	// additions. Real theme flips still go through setTheme()'s full sweep.
	const t3 = makeStale();
	document.body.append(t3);
	await tick();
	runFrame();
	t3.classList.add(STALE);
	document.body.append(makeStale());
	await tick();
	runFrame();
	ok('T3 pre-existing stale class left alone (intentional)', t3.classList.contains(STALE));

	// T4: no feedback loop. Removing classes must not queue another frame,
	// which proves the observer is not watching attributes.
	rafCalls = 0;
	runFrame();
	await tick();
	ok('T4 no feedback loop', rafCalls === 0, 'rafCalls=' + rafCalls);

	// T5: a node detached before the flush is skipped without throwing.
	const t5 = makeStale();
	document.body.append(t5);
	await tick();
	t5.remove();
	let t5threw = false;
	try {
		runFrame();
	} catch {
		t5threw = true;
	}
	ok('T5 tolerates detached node', !t5threw);

	// T6: bounded degrade. rAF never runs (window hidden), so the queue must cap
	// and fall back to one whole-document sweep that DOES clean a pre-existing
	// stale class. This is the safety valve for a hidden/backgrounded window.
	const t6pre = makeStale();
	document.body.append(t6pre);
	await tick();
	runFrame();
	t6pre.classList.add(STALE);
	for (let i = 0; i < 260; i++) {
		document.body.append(makeStale());
		await tick();
	}
	ok('T6 bounded degrade sweeps pre-existing', !t6pre.classList.contains(STALE));

	// T7: polarity follows the mode. In light mode the stale class is __fb-dark-mode.
	nativeTheme.shouldUseDarkColors = false;
	const t7stale = makeStale('__fb-dark-mode');
	const t7fresh = makeStale('__fb-light-mode');
	document.body.append(t7stale, t7fresh);
	await tick();
	runFrame();
	ok('T7 strips __fb-dark-mode in light mode', !t7stale.classList.contains('__fb-dark-mode'));
	ok('T7 keeps __fb-light-mode in light mode', t7fresh.classList.contains('__fb-light-mode'));

	// T8: idempotent on nodes that carry no stale class.
	let t8threw = false;
	try {
		document.body.append(document.createElement('div'));
		await tick();
		runFrame();
	} catch {
		t8threw = true;
	}
	ok('T8 idempotent on clean nodes', !t8threw);

	// T9: non-element additions (text nodes) must not throw. The old
	// observeThemeBugs() ignored them; the new one filters them explicitly.
	let t9threw = false;
	try {
		document.body.append(document.createTextNode('plain text'));
		await tick();
		runFrame();
	} catch {
		t9threw = true;
	}
	ok('T9 tolerates text-node additions', !t9threw);

	// T10: before/after work measurement. Instrument both querySelectorAll
	// prototypes so we can count whole-document theme scans versus subtree-scoped
	// ones. The old implementation ran one whole-document scan per mutation batch;
	// the new one must run none in the common case.
	const globalScope = globalThis;
	const documentProto = globalScope.Document.prototype;
	const elementProto = globalScope.Element.prototype;
	const originalDocumentQuery = documentProto.querySelectorAll;
	const originalElementQuery = elementProto.querySelectorAll;

	let wholeDocumentScans = 0;
	let scopedQueries = 0;

	const isThemeSelector = selector => typeof selector === 'string' && selector.includes('__fb-');

	documentProto.querySelectorAll = function (selector) {
		if (isThemeSelector(selector)) {
			wholeDocumentScans++;
		}
		return originalDocumentQuery.call(this, selector);
	};
	elementProto.querySelectorAll = function (selector) {
		if (isThemeSelector(selector)) {
			scopedQueries++;
		}
		return originalElementQuery.call(this, selector);
	};

	// Settle any pending work from earlier tests.
	runFrame();
	await tick();
	wholeDocumentScans = 0;
	scopedQueries = 0;

	const BATCHES = 50;
	for (let i = 0; i < BATCHES; i++) {
		document.body.append(makeStale());
		await tick();      // one observer callback per batch, as in production
		runFrame();        // and one frame between batches
	}

	documentProto.querySelectorAll = originalDocumentQuery;
	elementProto.querySelectorAll = originalElementQuery;

	ok('T10 no whole-document scans', wholeDocumentScans === 0, 'scans=' + wholeDocumentScans);
	ok('T10 scoped work is one query per batch', scopedQueries === BATCHES, 'scoped=' + scopedQueries);
	results.push('INFO :: ' + BATCHES + ' mutation batches -> this build: ' + wholeDocumentScans +
		' whole-document scans, ' + scopedQueries + ' subtree queries');

	return results;
})()
`;

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	// `outside-only` gives `window.eval` the window's global scope without
	// executing any script tags from the document.
	runScripts: 'outside-only',
	pretendToBeVisual: true,
	url: 'https://www.facebook.com/messages/',
});

const results = await dom.window.eval(testScript);

let failed = 0;
for (const line of results) {
	console.log(line);
	if (line.startsWith('FAIL')) {
		failed++;
	}
}

console.log(`\nSUMMARY: ${results.length} assertions, ${failed} failed`);
dom.window.close();
process.exitCode = failed > 0 ? 1 : 0;

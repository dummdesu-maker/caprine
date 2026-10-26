// Temporary verification harness for audit finding #2 (coalesced window-state
// saves).
//
// Extracts the compiled debounce/flush pair from dist-js/index.js and drives it
// with a counting saveWindowState stub, so the coalescing and — more
// importantly — the flush-on-close/quit behaviour can be asserted.
//
// Usage: npm run build && node debug/window-state-harness.mjs

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';

const sourcePath = process.argv[2]
	? path.resolve(process.argv[2])
	: fileURLToPath(new URL('../dist-js/index.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});

const wantedVariables = new Set(['WINDOW_STATE_SAVE_DELAY_MS', 'windowStateSaveTimer']);
const wantedFunctions = new Set(['scheduleSaveWindowState', 'flushWindowState']);

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
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// A `saveWindowState` stub has to exist in scope before the extracted code runs.
const build = () => new Function('saveWindowState', `
	const state = {saves: 0};
	${extracted}
	return {state, delay: WINDOW_STATE_SAVE_DELAY_MS, scheduleSaveWindowState, flushWindowState};
`);

const make = () => {
	const counter = {saves: 0};
	const api = build()(() => {
		counter.saves++;
	});
	return {counter, ...api};
};

// --- a drag burst collapses to one save --------------------------------
{
	const mod = make();
	for (let index = 0; index < 25; index++) {
		mod.scheduleSaveWindowState();
	}

	ok('burst: nothing written immediately', mod.counter.saves === 0, `saves=${mod.counter.saves}`);

	await wait(mod.delay + 120);
	ok('burst: one save after the burst', mod.counter.saves === 1, `saves=${mod.counter.saves}`);
}

// --- each new event pushes the deadline out ----------------------------
{
	const mod = make();
	mod.scheduleSaveWindowState();
	await wait(mod.delay - 150);
	mod.scheduleSaveWindowState();
	await wait(mod.delay - 150);

	ok('reschedule: timer restarted', mod.counter.saves === 0, `saves=${mod.counter.saves}`);

	await wait(200);
	ok('reschedule: saves once afterwards', mod.counter.saves === 1, `saves=${mod.counter.saves}`);
}

// --- flush writes immediately and cancels the pending timer ------------
{
	const mod = make();
	mod.scheduleSaveWindowState();
	mod.flushWindowState();

	ok('flush: writes immediately', mod.counter.saves === 1, `saves=${mod.counter.saves}`);

	await wait(mod.delay + 120);
	ok('flush: pending timer does not fire again', mod.counter.saves === 1, `saves=${mod.counter.saves}`);
}

// --- flush with nothing pending still writes (quit without resizing) ---
{
	const mod = make();
	mod.flushWindowState();
	ok('flush: writes when idle', mod.counter.saves === 1, `saves=${mod.counter.saves}`);
}

// --- two flushes (before-quit then close) both write -------------------
{
	const mod = make();
	mod.scheduleSaveWindowState();
	mod.flushWindowState();
	mod.flushWindowState();
	ok('quit path: before-quit then close both persist', mod.counter.saves === 2, `saves=${mod.counter.saves}`);
}

const failed = results.filter(line => line.startsWith('FAIL')).length;
for (const line of results) {
	console.log(line);
}

console.log(`\nSUMMARY: ${results.length} assertions, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

// Temporary verification harness for audit finding #3 (in-memory config mirror).
//
// Extracts the compiled mirror, its refresh, and its two setters from
// dist-js/config-flags.js and drives them with a fake store, so the contract
// "a setter updates the store and the mirror together" can be asserted — that
// is the whole point of the module, and the one way it can silently rot.
//
// Usage: npm run build && node debug/config-flags-harness.mjs

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';

const sourcePath = process.argv[2]
	? path.resolve(process.argv[2])
	: fileURLToPath(new URL('../dist-js/config-flags.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});

const wantedFunctions = new Set(['readHotFlags', 'refreshConfigFlags', 'setBlockFlag', 'setConfigFlag']);
const extracted = new Map();

for (const node of ast.body) {
	if (node.type === 'FunctionDeclaration' && node.id && wantedFunctions.has(node.id.name)) {
		extracted.set(node.id.name, source.slice(node.start, node.end));
	}
}

const missing = [...wantedFunctions].filter(name => !extracted.has(name));
if (missing.length > 0) {
	throw new Error(`Could not extract: ${missing.join(', ')}`);
}

const createInstance = initial => {
	const store = JSON.parse(JSON.stringify(initial));
	const calls = {reads: [], writes: []};

	const fakeStore = {
		get(key) {
			calls.reads.push(key);
			return store[key];
		},
		set(key, value) {
			calls.writes.push([key, value]);
			store[key] = value;
		},
	};

	// TypeScript rewrites an exported `let`/`const` and its assignments through
	// `exports`, so the module code needs an `exports` object to write to.
	const api = new Function('config_1', 'exports', `
		${extracted.get('readHotFlags')}
		${extracted.get('refreshConfigFlags')}
		${extracted.get('setBlockFlag')}
		${extracted.get('setConfigFlag')}
		exports.configFlags = readHotFlags();
		return {
			configFlags: exports.configFlags,
			readHotFlags,
			refreshConfigFlags,
			setBlockFlag,
			setConfigFlag,
		};
	`)({default: fakeStore}, {});

	return {store, calls, ...api};
};

const initialStore = {
	block: {chatSeen: false, typingIndicator: true, deliveryReceipt: false},
	callRingtoneMuted: false,
	showUnreadBadge: true,
	bounceDockOnMessage: false,
	flashWindowOnMessage: true,
};

const results = [];
const ok = (name, condition, extra) => {
	results.push(`${condition ? 'PASS' : 'FAIL'} :: ${name}${extra ? ` [${extra}]` : ''}`);
};

// --- initialisation -----------------------------------------------------
{
	const mod = createInstance(initialStore);

	ok('init: reads the block object once', mod.calls.reads.filter(key => key === 'block').length === 1);
	ok('init: five reads total', mod.calls.reads.length === 5, `reads=${mod.calls.reads.length}`);
	ok('init: block flags copied', mod.configFlags.chatSeen === false && mod.configFlags.typingIndicator === true);
	ok('init: scalar flags copied', mod.configFlags.showUnreadBadge === true && mod.configFlags.callRingtoneMuted === false);
}

// --- a boolean flag keeps the mirror in step ----------------------------
{
	const mod = createInstance(initialStore);
	mod.setConfigFlag('showUnreadBadge', false);

	ok('boolean: store written', mod.store.showUnreadBadge === false);
	ok('boolean: mirror updated', mod.configFlags.showUnreadBadge === false);
	ok('boolean: single write', mod.calls.writes.length === 1, `writes=${mod.calls.writes.length}`);
	ok('boolean: written under the right key', mod.calls.writes[0][0] === 'showUnreadBadge');

	mod.setConfigFlag('showUnreadBadge', true);
	ok('boolean: round trip', mod.store.showUnreadBadge === true && mod.configFlags.showUnreadBadge === true);
}

// --- a block flag preserves its siblings --------------------------------
{
	const mod = createInstance(initialStore);
	mod.setBlockFlag('chatSeen', true);

	ok('block: store written', mod.store.block.chatSeen === true);
	ok('block: mirror updated', mod.configFlags.chatSeen === true);
	ok('block: sibling preserved in store', mod.store.block.typingIndicator === true && mod.store.block.deliveryReceipt === false);
	ok('block: sibling preserved in mirror', mod.configFlags.typingIndicator === true && mod.configFlags.deliveryReceipt === false);
	ok('block: written as one object', mod.calls.writes[0][0] === 'block');
}

// --- refresh picks up an externally edited config -----------------------
{
	const mod = createInstance(initialStore);

	// Simulate the user hand-editing config.json, which the app only re-reads
	// when the menu is rebuilt.
	mod.store.block.chatSeen = true;
	mod.store.callRingtoneMuted = true;

	ok('refresh: mirror stale before', mod.configFlags.chatSeen === false && mod.configFlags.callRingtoneMuted === false);

	const beforeRefresh = mod.configFlags;
	mod.refreshConfigFlags();

	ok('refresh: mirror picks up block change', mod.configFlags.chatSeen === true);
	ok('refresh: mirror picks up scalar change', mod.configFlags.callRingtoneMuted === true);
	// Readers and setters share one object, so a refresh must update in place
	// rather than swap in a new one.
	ok('refresh: updates in place', mod.configFlags === beforeRefresh);
}

// --- mirror never diverges from the store -------------------------------
{
	const mod = createInstance(initialStore);
	mod.setBlockFlag('deliveryReceipt', true);
	mod.setBlockFlag('chatSeen', true);
	mod.setConfigFlag('flashWindowOnMessage', false);
	mod.setConfigFlag('bounceDockOnMessage', true);

	const divergence = [];
	for (const key of ['callRingtoneMuted', 'showUnreadBadge', 'bounceDockOnMessage', 'flashWindowOnMessage']) {
		if (mod.configFlags[key] !== mod.store[key]) {
			divergence.push(key);
		}
	}

	for (const key of ['chatSeen', 'typingIndicator', 'deliveryReceipt']) {
		if (mod.configFlags[key] !== mod.store.block[key]) {
			divergence.push(`block.${key}`);
		}
	}

	ok('consistency: mirror matches store after several writes', divergence.length === 0, divergence.join(','));
}

const failed = results.filter(line => line.startsWith('FAIL')).length;
for (const line of results) {
	console.log(line);
}

console.log(`\nSUMMARY: ${results.length} assertions, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

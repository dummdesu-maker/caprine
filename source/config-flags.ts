import config from './config';

/**
Values that are read on hot paths — every intercepted network request, every
badge update, every window focus — where a `config.get()` would cost a
synchronous disk read, because the underlying store keeps no in-memory copy.

Refreshed from the store whenever the menu is rebuilt (startup, every page
load, and after any setting changes), and kept in step by the setters below,
which are the only writers of these keys.
*/
export type ConfigFlags = {
	chatSeen: boolean;
	typingIndicator: boolean;
	deliveryReceipt: boolean;
	callRingtoneMuted: boolean;
	showUnreadBadge: boolean;
	bounceDockOnMessage: boolean;
	flashWindowOnMessage: boolean;
};

function readHotFlags(): ConfigFlags {
	// One read for the nested object rather than three for its members.
	const block = config.get('block');

	return {
		chatSeen: block.chatSeen,
		typingIndicator: block.typingIndicator,
		deliveryReceipt: block.deliveryReceipt,
		callRingtoneMuted: config.get('callRingtoneMuted'),
		showUnreadBadge: config.get('showUnreadBadge'),
		bounceDockOnMessage: config.get('bounceDockOnMessage'),
		flashWindowOnMessage: config.get('flashWindowOnMessage'),
	};
}

export const configFlags: ConfigFlags = readHotFlags();

/** Re-reads the mirror from the store. Cheap to call; not on any hot path. */
export function refreshConfigFlags(): void {
	Object.assign(configFlags, readHotFlags());
}

export type BlockFlag = 'chatSeen' | 'typingIndicator' | 'deliveryReceipt';

export type BooleanFlag =
	| 'callRingtoneMuted'
	| 'showUnreadBadge'
	| 'bounceDockOnMessage'
	| 'flashWindowOnMessage';

/** Persists a privacy flag and updates the mirror in the same step. */
export function setBlockFlag(flag: BlockFlag, value: boolean): void {
	config.set('block', {...config.get('block'), [flag]: value});
	configFlags[flag] = value;
}

/** Persists a top-level boolean flag and updates the mirror in the same step. */
export function setConfigFlag(flag: BooleanFlag, value: boolean): void {
	config.set(flag, value);
	configFlags[flag] = value;
}

// @ts-check

import { getJson } from "./http.mjs";

/**
 * @typedef {{ id: string, [key: string]: unknown }} MagpieEntry
 */

/**
 * @param {string} value
 */
export function normalizeMagpieUrl(value) {
	let root = value.trim().replace(/\/+$/, "");
	if (!root) throw new Error("Remote magpie address is required");
	if (!root.includes("://")) root = `http://${root}`;
	for (const suffix of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1"]) {
		if (root.endsWith(suffix)) {
			root = root.slice(0, -suffix.length);
			break;
		}
	}
	return root;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {MagpieEntry[]}
 */
function catalogEntries(value) {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new Error("invalid model catalog returned by remote magpie");
	}
	return value.data.filter(
		(entry) =>
			isRecord(entry) &&
			typeof entry.id === "string" &&
			entry.id.length > 0 &&
			!(typeof entry.kind === "string" && entry.kind.length > 0),
	);
}

/**
 * @param {string} root
 * @param {string} key
 * @param {number} [timeoutMs]
 * @returns {Promise<MagpieEntry[]>}
 */
export async function fetchMagpieCatalog(root, key, timeoutMs = 10_000) {
	let response;
	try {
		response = await getJson(`${root}/v1/models`, {
			headers: {
				accept: "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			timeoutMs,
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "InvalidJsonError")) {
			throw error;
		}
		throw new Error(`cannot reach ${root}`, { cause: error });
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error("gateway key rejected (is Share on local network on and the key enabled?)");
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`model list request to ${root} failed with HTTP ${response.status}`);
	}
	return catalogEntries(response.body);
}

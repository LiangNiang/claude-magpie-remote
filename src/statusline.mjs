// @ts-check

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fetchMagpieQuotas, formatQuotaStatus, mostUsed, quotasForModel } from "./quota.mjs";
import { getConfigPaths, readSettings, resolveConnection } from "./settings.mjs";
import { normalizeMagpieUrl } from "./magpie.mjs";

const QUOTA_TTL_MS = 60_000;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} input
 */
function modelFromInput(input) {
	try {
		const parsed = JSON.parse(input);
		const id = parsed?.model?.id;
		return typeof id === "string" ? id.replace(/\s*\[[^\]]*\]$/, "") : "";
	} catch {
		return "";
	}
}

/**
 * @param {unknown} value
 * @returns {value is { root: string, at: number, quotas: import("./quota.mjs").MagpieQuota[] }}
 */
function isCache(value) {
	return (
		isRecord(value) &&
		typeof value.root === "string" &&
		typeof value.at === "number" &&
		Array.isArray(value.quotas)
	);
}

/** @returns {Promise<import("./quota.mjs").MagpieQuota[] | undefined>} */
async function readCache() {
	try {
		const value = JSON.parse(await readFile(getConfigPaths().cacheFile, "utf8"));
		return isCache(value) ? value.quotas : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {string} root
 * @param {import("./quota.mjs").MagpieQuota[]} quotas
 */
async function writeCache(root, quotas) {
	try {
		const { pluginDir, cacheFile } = getConfigPaths();
		await mkdir(pluginDir, { recursive: true });
		await writeFile(cacheFile, `${JSON.stringify({ root, at: Date.now(), quotas }, null, 2)}\n`, "utf8");
	} catch {}
}

/**
 * @param {string} input
 * @param {number} [now]
 * @returns {Promise<string>}
 */
export async function renderStatusLine(input, now = Date.now()) {
	try {
		const modelId = modelFromInput(input);
		if (!modelId) return "";
		const settings = await readSettings();
		const connection = resolveConnection(settings);
		if (!connection.root) return "";
		const root = normalizeMagpieUrl(connection.root);
		let quotas;
		let cache;
		try {
			const { cacheFile } = getConfigPaths();
			cache = JSON.parse(await readFile(cacheFile, "utf8"));
		} catch {}
		if (isCache(cache) && cache.root === root && now - cache.at < QUOTA_TTL_MS) {
			quotas = cache.quotas;
		} else {
			try {
				quotas = await fetchMagpieQuotas(root, connection.key, 4000);
				await writeCache(root, quotas);
			} catch {
				const stale = await readCache();
				if (!stale || !isCache(cache) || cache.root !== root) return "";
				quotas = stale;
			}
		}
		const matching = quotasForModel(quotas, modelId);
		if (matching.length === 0) return "";
		const first = matching[0];
		const report = `${formatQuotaStatus(first)}${matching.length > 1 ? ` +${matching.length - 1}` : ""}`;
		const used = mostUsed(first);
		if (first.error || used === undefined || used < 75) return `\x1b[2m${report}\x1b[0m`;
		if (used >= 90) return `\x1b[31m${report}\x1b[0m`;
		return `\x1b[33m${report}\x1b[0m`;
	} catch {
		return "";
	}
}

/** @returns {Promise<void>} */
export async function runStatusLine() {
	try {
		let input = "";
		for await (const chunk of process.stdin) input += chunk;
		const rendered = await renderStatusLine(input);
		if (rendered) process.stdout.write(`${rendered}\n`);
	} catch {}
}

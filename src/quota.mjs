// @ts-check

import { getJson } from "./http.mjs";

/**
 * @typedef {{ name: string, used: number, unlimited?: boolean, resetsAt?: string, display?: string }} MagpieQuotaWindow
 * @typedef {{
 *   provider: string, name: string, kind: string, plan?: string, user?: string,
 *   windows: MagpieQuotaWindow[], balance?: string, error?: string,
 *   resets?: { count?: number, until?: string }, last?: boolean
 * }} MagpieQuota
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {MagpieQuotaWindow[]}
 */
function parseWindow(value) {
	if (!isRecord(value) || typeof value.name !== "string") return [];
	return [
		{
			name: value.name,
			used: typeof value.used === "number" && Number.isFinite(value.used) ? value.used : 0,
			unlimited: value.unlimited === true || undefined,
			resetsAt: optionalString(value.resetsAt),
			display: optionalString(value.display),
		},
	];
}

/**
 * @param {unknown} value
 * @returns {MagpieQuota[]}
 */
export function parseMagpieQuotas(value) {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("invalid quota list returned by remote magpie");
	return value.data.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry.provider !== "string" || entry.provider.length === 0) return [];
		const resets = isRecord(entry.resets)
			? {
					count: typeof entry.resets.count === "number" ? entry.resets.count : undefined,
					until: optionalString(entry.resets.until),
				}
			: undefined;
		return [
			{
				provider: entry.provider,
				name: optionalString(entry.name) ?? entry.provider,
				kind: optionalString(entry.kind) ?? "subscription",
				plan: optionalString(entry.plan),
				user: optionalString(entry.user),
				windows: Array.isArray(entry.windows) ? entry.windows.flatMap(parseWindow) : [],
				balance: optionalString(entry.balance),
				error: optionalString(entry.error),
				resets,
				last: entry.last === true || undefined,
			},
		];
	});
}

/**
 * @param {string} root
 * @param {string} key
 * @param {number} [timeoutMs]
 * @returns {Promise<MagpieQuota[]>}
 */
export async function fetchMagpieQuotas(root, key, timeoutMs = 10_000) {
	let response;
	try {
		response = await getJson(`${root}/v1/magpie/quotas`, {
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
		throw new Error(`quota request to ${root} failed with HTTP ${response.status}`);
	}
	return parseMagpieQuotas(response.body);
}

/** @param {string} modelId */
export function quotaProviderOf(modelId) {
	const slash = modelId.indexOf("/");
	return (slash > 0 ? modelId.slice(0, slash) : modelId).toLowerCase();
}

/**
 * @param {readonly MagpieQuota[]} quotas
 * @param {string} modelId
 * @returns {MagpieQuota[]}
 */
export function quotasForModel(quotas, modelId) {
	const provider = quotaProviderOf(modelId);
	return quotas
		.filter((quota) => quota.provider.toLowerCase() === provider)
		.sort((a, b) => Number(b.last === true) - Number(a.last === true));
}

/** @type {Record<string, string>} */
const PERIODS = { hourly: "1h", daily: "1d", weekly: "1w", monthly: "1mo" };

/** @param {string} name */
export function shortWindowName(name) {
	const period = PERIODS[name.trim().toLowerCase()];
	if (period) return period;
	const match = /^(\d+)\s*(hour|day|week|month|minute)s?$/i.exec(name.trim());
	if (!match) return name;
	const unit = match[2].toLowerCase();
	return `${match[1]}${unit === "minute" ? "m" : unit === "month" ? "mo" : unit[0]}`;
}

/** @param {number} used */
function percent(used) {
	return `${Math.round(used)}%`;
}

/** @param {number} n */
function pad(n) {
	return String(n).padStart(2, "0");
}

/**
 * @param {Date} at
 * @param {Date} now
 */
export function resetClock(at, now) {
	const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	/** @param {Date} date */
	const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const days = Math.round((day(at) - day(now)) / 86_400_000);
	if (days <= 0) return clock;
	if (days === 1) return `tomorrow ${clock}`;
	if (days < 7) return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
	return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clock}`;
}

/** @param {MagpieQuota} quota */
export function mostUsed(quota) {
	const used = quota.windows.filter((window) => !window.unlimited).map((window) => window.used);
	return used.length > 0 ? Math.max(...used) : undefined;
}

/** @param {MagpieQuota} quota */
export function formatQuotaStatus(quota) {
	const limited = quota.windows.filter((window) => !window.unlimited);
	let shown = limited.slice(0, 2);
	const top = limited.reduce(
		/** @param {MagpieQuotaWindow | undefined} a @param {MagpieQuotaWindow} window */
		(a, window) => (a && a.used >= window.used ? a : window),
		undefined,
	);
	if (top && !shown.includes(top)) shown = [shown[0], top].filter(Boolean);
	const parts = shown.map((window) => `${shortWindowName(window.name)} ${percent(window.used)}`);
	if (quota.balance) parts.push(quota.balance);
	if (parts.length === 0) {
		parts.push(quota.error ? "unavailable" : quota.windows.length > 0 ? "unlimited" : (quota.plan ?? "—"));
	}
	return `${quota.provider} ${parts.join(" · ")}`;
}

/** @param {MagpieQuota} quota */
function quotaTitle(quota) {
	return [quota.provider, quota.plan, quota.user].filter(Boolean).join(" · ");
}

/**
 * @param {MagpieQuotaWindow} window
 * @param {Date} now
 */
function windowCell(window, now) {
	if (window.unlimited) return `${window.name} unlimited`;
	let cell = `${window.name} ${percent(window.used)}`;
	if (window.display) cell += ` (${window.display})`;
	const at = window.resetsAt ? new Date(window.resetsAt) : undefined;
	if (at && !Number.isNaN(at.getTime())) cell += ` ↻ ${resetClock(at, now)}`;
	return cell;
}

/**
 * @param {readonly MagpieQuota[]} quotas
 * @param {Date} [now]
 */
export function formatQuotaReport(quotas, now = new Date()) {
	if (quotas.length === 0) return "Remote magpie has no subscription, plan or key balance to report.";
	const width = Math.max(...quotas.map(quotaTitle).map((title) => title.length));
	const lines = quotas.map((quota) => {
		/** @type {string[]} */
		const cells = quota.windows.map((window) => windowCell(window, now));
		if (quota.balance) cells.push(`${quota.balance} left`);
		if (quota.resets?.count) cells.push(`↺ ${quota.resets.count} reset${quota.resets.count === 1 ? "" : "s"}`);
		if (quota.error) cells.push(quota.error);
		return [quotaTitle(quota).padEnd(width), quota.kind.padEnd(12), ...cells].join("  ").trimEnd();
	});
	return [...lines, "% is how much of a window is used · ↻ when it starts again"].join("\n");
}

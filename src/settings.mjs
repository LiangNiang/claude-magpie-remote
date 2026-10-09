// @ts-check

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMagpieCatalog } from "./magpie.mjs";

/**
 * @typedef {{
 *   root: string, version: string, previous: Record<string, unknown | null>,
 *   picker?: boolean, onboarding?: unknown | null
 * }} MagpieState
 * @typedef {{ model: string, label: string, description: string }} ModelPickerOption
 * @typedef {Record<string, unknown>} Settings
 */

const SETTINGS_PATHS = [
	"env.ANTHROPIC_BASE_URL",
	"env.ANTHROPIC_AUTH_TOKEN",
	"env.ANTHROPIC_DEFAULT_OPUS_MODEL",
	"env.ANTHROPIC_DEFAULT_SONNET_MODEL",
	"env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"env.ANTHROPIC_SMALL_FAST_MODEL",
	"env.ANTHROPIC_MODEL",
	"model",
	"modelPicker",
	"statusLine",
];

/** @returns {{ configDir: string, settingsFile: string, claudeProfileFile: string, pluginDir: string, stateFile: string, cacheFile: string, libDir: string }} */
export function getConfigPaths() {
	const configDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
	const profileDir = process.env.CLAUDE_CONFIG_DIR
		? path.resolve(process.env.CLAUDE_CONFIG_DIR)
		: os.homedir();
	const pluginDir = path.join(configDir, "magpie-remote");
	return {
		configDir,
		settingsFile: path.join(configDir, "settings.json"),
		claudeProfileFile: path.join(profileDir, ".claude.json"),
		pluginDir,
		stateFile: path.join(pluginDir, "state.json"),
		cacheFile: path.join(pluginDir, "quota-cache.json"),
		libDir: path.join(pluginDir, "lib"),
	};
}

/**
 * @param {import("./magpie.mjs").MagpieEntry[]} catalog
 * @returns {ModelPickerOption[]}
 */
export function buildModelPickerRows(catalog) {
	return catalog.map((entry) => {
		const magpieLabel = entry.magpie_label;
		const displayName = entry.display_name;
		const label = typeof magpieLabel === "string" && magpieLabel
			? magpieLabel
			: typeof displayName === "string" && displayName
				? displayName
				: entry.id;
		return {
			model: entry.id,
			label,
			description: `Magpie · ${entry.id}`,
		};
	});
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} dottedPath
 * @param {unknown} value
 * @returns {unknown}
 */
export function getSetting(value, dottedPath) {
	let current = value;
	for (const part of dottedPath.split(".")) {
		if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
		current = current[part];
	}
	return current;
}

/**
 * @param {Settings} settings
 * @param {string} dottedPath
 * @param {unknown} value
 */
function setSetting(settings, dottedPath, value) {
	const parts = dottedPath.split(".");
	let current = settings;
	for (const part of parts.slice(0, -1)) {
		if (!isRecord(current[part])) current[part] = {};
		current = /** @type {Settings} */ (current[part]);
	}
	const key = parts.at(-1);
	if (key === undefined) throw new Error("setting path cannot be empty");
	current[key] = value;
}

/**
 * @param {Settings} settings
 * @param {string} dottedPath
 */
function deleteSetting(settings, dottedPath) {
	const parts = dottedPath.split(".");
	let current = settings;
	for (const part of parts.slice(0, -1)) {
		if (!isRecord(current[part])) return;
		current = /** @type {Settings} */ (current[part]);
	}
	const key = parts.at(-1);
	if (key === undefined) return;
	delete current[key];
	if (parts[0] === "env" && isRecord(settings.env) && Object.keys(settings.env).length === 0) {
		delete settings.env;
	}
}

/** @returns {Promise<Settings>} */
export async function readSettings() {
	const { settingsFile } = getConfigPaths();
	let text;
	try {
		text = await readFile(settingsFile, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}
	let settings;
	try {
		settings = JSON.parse(text);
	} catch (error) {
		throw new Error(`Cannot read ${settingsFile}: invalid JSON; fix the file before using magpie-remote`, {
			cause: error,
		});
	}
	if (!isRecord(settings)) {
		throw new Error(`Cannot read ${settingsFile}: expected a JSON object`);
	}
	return settings;
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
async function writeJsonFileAtomically(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporaryFile, filePath);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFile(error) {
	return isRecord(error) && error.code === "ENOENT";
}

/**
 * @param {Settings} settings
 */
export async function writeSettings(settings) {
	const { settingsFile } = getConfigPaths();
	await writeJsonFileAtomically(settingsFile, settings);
}

/**
 * @param {string} profileFile
 * @returns {Promise<{ profile: Record<string, unknown>, previous: unknown | null } | { warning: string }>}
 */
async function readOnboardingProfile(profileFile) {
	let text;
	try {
		text = await readFile(profileFile, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { profile: {}, previous: null };
		throw error;
	}
	let profile;
	try {
		profile = JSON.parse(text);
	} catch {
		return {
			warning: "Warning: Claude Code global config is not a valid JSON object; onboarding state was left unchanged.",
		};
	}
	if (!isRecord(profile)) {
		return {
			warning: "Warning: Claude Code global config is not a valid JSON object; onboarding state was left unchanged.",
		};
	}
	const previous = Object.hasOwn(profile, "hasCompletedOnboarding")
		? structuredClone(profile.hasCompletedOnboarding)
		: null;
	return { profile, previous };
}

/**
 * @param {unknown} value
 * @returns {value is MagpieState}
 */
function isMagpieState(value) {
	return (
		isRecord(value) &&
		typeof value.root === "string" &&
		typeof value.version === "string" &&
		isRecord(value.previous) &&
		(!Object.hasOwn(value, "picker") || typeof value.picker === "boolean")
	);
}

/** @returns {Promise<MagpieState | undefined>} */
export async function readState() {
	const { stateFile } = getConfigPaths();
	let text;
	try {
		text = await readFile(stateFile, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
	let state;
	try {
		state = JSON.parse(text);
	} catch (error) {
		throw new Error(`Cannot read ${stateFile}: invalid state JSON`, { cause: error });
	}
	if (!isMagpieState(state)) throw new Error(`Cannot read ${stateFile}: invalid magpie-remote state`);
	return state;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown> & { command: string }}
 */
function isStatusLine(value) {
	return isRecord(value) && typeof value.command === "string";
}

/** @param {unknown} value */
export function isMagpieStatusLine(value) {
	return isStatusLine(value) && value.command.replaceAll(path.sep, "/").includes("magpie-remote/lib");
}

/**
 * @param {string} commandPath
 */
function quoteCommandPath(commandPath) {
	return commandPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * @param {{
 *   root: string, key: string, catalog: import("./magpie.mjs").MagpieEntry[],
 *   model: string, fastModel: string,
 *   noStatusline: boolean, version: string
 * }} options
 */
export async function saveLoginSettings(options) {
	const paths = getConfigPaths();
	const settings = await readSettings();
	const existingState = await readState();
	const onboardingProfile = await readOnboardingProfile(paths.claudeProfileFile);
	const onboardingPrevious = Object.hasOwn(existingState ?? {}, "onboarding")
		? existingState?.onboarding
		: "profile" in onboardingProfile
			? onboardingProfile.previous
			: undefined;
	/** @type {Record<string, unknown | null>} */
	let previous = existingState?.previous ?? {};
	if (!existingState) {
		previous = {};
	}
	for (const dottedPath of SETTINGS_PATHS) {
		if (Object.hasOwn(previous, dottedPath)) continue;
		const oldValue = getSetting(settings, dottedPath);
		previous[dottedPath] = oldValue === undefined ? null : structuredClone(oldValue);
	}

	const currentPicker = getSetting(settings, "modelPicker");
	const ownsPicker = currentPicker === undefined || existingState?.picker === true;
	await copyLibrary(path.dirname(fileURLToPath(import.meta.url)), paths.libDir, options.version);
	await mkdir(paths.pluginDir, { recursive: true });
	/** @type {MagpieState} */
	const state = { root: options.root, version: options.version, previous, picker: ownsPicker };
	if (onboardingPrevious !== undefined) state.onboarding = onboardingPrevious;
	await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	if ("profile" in onboardingProfile) {
		await writeJsonFileAtomically(paths.claudeProfileFile, {
			...onboardingProfile.profile,
			hasCompletedOnboarding: true,
		});
	}

	setSetting(settings, "env.ANTHROPIC_BASE_URL", options.root);
	setSetting(settings, "env.ANTHROPIC_AUTH_TOKEN", options.key);
	setSetting(settings, "model", options.model);
	setSetting(settings, "env.ANTHROPIC_DEFAULT_OPUS_MODEL", options.model);
	setSetting(settings, "env.ANTHROPIC_DEFAULT_SONNET_MODEL", options.model);
	setSetting(settings, "env.ANTHROPIC_DEFAULT_HAIKU_MODEL", options.fastModel);
	setSetting(settings, "env.ANTHROPIC_SMALL_FAST_MODEL", options.fastModel);
	deleteSetting(settings, "env.ANTHROPIC_MODEL");
	if (ownsPicker) {
		setSetting(settings, "modelPicker", {
			options: buildModelPickerRows(options.catalog),
			replaceBuiltInOptions: true,
		});
	}

	const currentStatusLine = getSetting(settings, "statusLine");
	if (
		!options.noStatusline &&
		(currentStatusLine === undefined || isMagpieStatusLine(currentStatusLine))
	) {
		const statuslinePath = path.join(paths.libDir, "cli.mjs");
		setSetting(settings, "statusLine", {
			type: "command",
			command: `node "${quoteCommandPath(statuslinePath)}" statusline`,
			refreshInterval: 60,
		});
	}

	await writeSettings(settings);
	return {
		settings,
		hasCustomStatusLine:
			!options.noStatusline &&
			currentStatusLine !== undefined &&
			!isMagpieStatusLine(currentStatusLine),
		hasCustomModelPicker: !ownsPicker,
		libDir: paths.libDir,
		onboardingWarning: "warning" in onboardingProfile ? onboardingProfile.warning : undefined,
	};
}

/**
 * @param {string} sourceDir
 * @param {string} libDir
 * @param {string} version
 */
async function copyLibrary(sourceDir, libDir, version) {
	await rm(libDir, { recursive: true, force: true });
	await mkdir(libDir, { recursive: true });
	const files = await readdir(sourceDir, { withFileTypes: true });
	for (const file of files) {
		if (file.isFile() && file.name.endsWith(".mjs")) {
			const content = await readFile(path.join(sourceDir, file.name));
			await writeFile(path.join(libDir, file.name), content);
		}
	}
	await writeFile(path.join(libDir, "VERSION"), `${version}\n`, "utf8");
}

/**
 * @param {Settings} settings
 * @returns {{ root: string, key: string }}
 */
export function resolveConnection(settings) {
	const env = process.env;
	const settingBaseUrl = getSetting(settings, "env.ANTHROPIC_BASE_URL");
	const settingKey = getSetting(settings, "env.ANTHROPIC_AUTH_TOKEN");
	return {
		root:
			env.ANTHROPIC_BASE_URL !== undefined
				? env.ANTHROPIC_BASE_URL
				: typeof settingBaseUrl === "string"
					? settingBaseUrl
					: "",
		key:
			env.ANTHROPIC_AUTH_TOKEN !== undefined
				? env.ANTHROPIC_AUTH_TOKEN
				: typeof settingKey === "string"
					? settingKey
					: "",
	};
}

/** @returns {Promise<boolean>} */
export async function logoutSettings() {
	const state = await readState();
	if (!state) return false;
	const settings = await readSettings();
	const paths = getConfigPaths();
	for (const [dottedPath, value] of Object.entries(state.previous)) {
		if (value === null) deleteSetting(settings, dottedPath);
		else setSetting(settings, dottedPath, value);
	}
	await writeSettings(settings);
	if (Object.hasOwn(state, "onboarding")) {
		const onboardingProfile = await readOnboardingProfile(paths.claudeProfileFile);
		if ("profile" in onboardingProfile && onboardingProfile.profile.hasCompletedOnboarding === true) {
			if (state.onboarding === null) delete onboardingProfile.profile.hasCompletedOnboarding;
			else onboardingProfile.profile.hasCompletedOnboarding = structuredClone(state.onboarding);
			await writeJsonFileAtomically(paths.claudeProfileFile, onboardingProfile.profile);
		}
	}
	await rm(paths.stateFile, { force: true });
	await rm(paths.libDir, { recursive: true, force: true });
	return true;
}

/** @returns {Promise<void>} */
export async function syncLibrary() {
	/** @type {MagpieState | undefined} */
	let state;
	try {
		state = await readState();
		if (!state) return;
		const { libDir } = getConfigPaths();
		const moduleDir = path.dirname(fileURLToPath(import.meta.url));
		const packageJson = JSON.parse(await readFile(path.join(moduleDir, "..", "package.json"), "utf8"));
		if (typeof packageJson.version !== "string") return;
		const version = packageJson.version;
		let installedVersion = "";
		try {
			installedVersion = (await readFile(path.join(libDir, "VERSION"), "utf8")).trim();
		} catch {}
		if (installedVersion !== version) await copyLibrary(moduleDir, libDir, version);
	} catch {}
	if (!state?.picker) return;
	try {
		const settings = await readSettings();
		if (getSetting(settings, "env.ANTHROPIC_BASE_URL") !== state.root) return;
		const key = getSetting(settings, "env.ANTHROPIC_AUTH_TOKEN");
		const catalog = await fetchMagpieCatalog(
			state.root,
			typeof key === "string" ? key : "",
			AbortSignal.timeout(3000),
		);
		const rows = buildModelPickerRows(catalog);
		const picker = getSetting(settings, "modelPicker");
		const currentPicker = isRecord(picker) ? picker : {};
		const desiredPicker = { ...currentPicker, options: rows, replaceBuiltInOptions: true };
		if (JSON.stringify(currentPicker) === JSON.stringify(desiredPicker)) return;
		setSetting(settings, "modelPicker", desiredPicker);
		await writeSettings(settings);
	} catch {}
}

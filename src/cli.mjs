// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { fetchMagpieCatalog, normalizeMagpieUrl } from "./magpie.mjs";
import {
	fetchMagpieQuotas,
	formatQuotaReport,
	quotaProviderOf,
} from "./quota.mjs";
import {
	getConfigPaths,
	getSetting,
	logoutSettings,
	readSettings,
	resolveConnection,
	saveLoginSettings,
	syncLibrary,
} from "./settings.mjs";
import { runStatusLine } from "./statusline.mjs";

const HELP = `magpie-remote <command>

Commands:
  login [address] [--key K] [--model M] [--fast-model M] [--no-statusline]
  status
  usage [filters...] [--json]
  logout
  sync [--quiet]
  statusline
  help`;

/**
 * @param {string[]} args
 * @returns {{ positional: string[], values: Record<string, string>, flags: Set<string> }}
 */
function parseArgs(args) {
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, string>} */
	const values = {};
	const flags = new Set();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--key" || arg === "--model" || arg === "--fast-model") {
			const value = args[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			values[arg.slice(2)] = value;
		} else if (arg === "--no-statusline" || arg === "--json" || arg === "--no-fail" || arg === "--quiet") {
			flags.add(arg.slice(2));
		} else if (arg.startsWith("--")) {
			throw new Error(`unknown option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	return { positional, values, flags };
}

/**
 * @param {string} prompt
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
async function ask(prompt, defaultValue = "") {
	if (!stdin.isTTY) throw new Error("interactive input requires a TTY; provide the value as a flag");
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await rl.question(prompt);
		return answer.trim() || defaultValue;
	} finally {
		rl.close();
	}
}

/** @returns {Promise<string>} */
async function askHiddenKey() {
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
		throw new Error("interactive input requires a TTY; provide the gateway key with --key");
	}
	emitKeypressEvents(stdin);
	const wasRaw = stdin.isRaw;
	stdin.setRawMode(true);
	stdin.resume();
	stdout.write("Gateway key (input hidden; empty is allowed): ");
	return new Promise((resolve, reject) => {
		let value = "";
		/**
		 * @param {string} character
		 * @param {{ name?: string, ctrl?: boolean }} key
		 */
		const onKeypress = (character, key) => {
			if (key.ctrl && key.name === "c") {
				cleanup();
				stdout.write("\n");
				reject(new Error("login cancelled"));
				return;
			}
			if (key.name === "return" || key.name === "enter" || character === "\r" || character === "\n") {
				cleanup();
				stdout.write("\n");
				resolve(value);
				return;
			}
			if (key.name === "backspace" || key.name === "delete") {
				if (value.length > 0) {
					value = value.slice(0, -1);
					stdout.write("\b \b");
				}
				return;
			}
			if (character && !key.ctrl && character >= " ") {
				value += character;
				stdout.write("*");
			}
		};
		const cleanup = () => {
			stdin.off("keypress", onKeypress);
			stdin.setRawMode(wasRaw ?? false);
		};
		stdin.on("keypress", onKeypress);
	});
}

/**
 * @param {import("./magpie.mjs").MagpieEntry} entry
 */
function modelLabel(entry) {
	return typeof entry.display_name === "string" && entry.display_name ? entry.display_name : entry.id;
}

/**
 * @param {import("./magpie.mjs").MagpieEntry[]} catalog
 * @param {unknown} currentModel
 * @param {string | undefined} selectedModel
 * @returns {Promise<string>}
 */
async function chooseMainModel(catalog, currentModel, selectedModel) {
	/** @param {string} id */
	const exists = (id) => catalog.some((entry) => entry.id === id);
	if (selectedModel !== undefined) {
		if (!exists(selectedModel)) throw new Error(`model "${selectedModel}" is not in the remote catalog`);
		return selectedModel;
	}
	if (!stdin.isTTY) throw new Error("choose a main model with --model when stdin is not a TTY");
	const defaultIndex = typeof currentModel === "string" && exists(currentModel)
		? catalog.findIndex((entry) => entry.id === currentModel)
		: 0;
	console.log("Available Magpie models:");
	catalog.forEach((entry, index) => console.log(`  ${index + 1}. ${modelLabel(entry)} (${entry.id})`));
	const answer = await ask(`Select model [${defaultIndex + 1}]: `, String(defaultIndex + 1));
	const index = Number(answer);
	if (!Number.isInteger(index) || index < 1 || index > catalog.length) {
		throw new Error(`enter a number from 1 to ${catalog.length}`);
	}
	return catalog[index - 1].id;
}

/**
 * @param {import("./magpie.mjs").MagpieEntry[]} catalog
 * @param {string} model
 * @param {string | undefined} selectedFastModel
 * @returns {Promise<string>}
 */
async function chooseFastModel(catalog, model, selectedFastModel) {
	if (selectedFastModel !== undefined) {
		if (!catalog.some((entry) => entry.id === selectedFastModel)) {
			throw new Error(`fast model "${selectedFastModel}" is not in the remote catalog`);
		}
		return selectedFastModel;
	}
	if (!stdin.isTTY) return model;
	const answer = await ask(`Fast/background model [${model}] (Enter keeps it): `, model);
	if (!catalog.some((entry) => entry.id === answer)) {
		throw new Error(`fast model "${answer}" is not in the remote catalog`);
	}
	return answer;
}

/** @param {string} key */
export function maskGatewayKey(key) {
	if (!key) return "(empty)";
	return `****${key.length > 4 ? key.slice(-4) : ""}`;
}

/**
 * @param {string[]} args
 */
async function login(args) {
	const parsed = parseArgs(args);
	const addressArg = parsed.positional[0];
	const address = addressArg ?? (await ask("Remote magpie address (http://192.168.1.20:3425): "));
	const root = normalizeMagpieUrl(address);
	const key = parsed.values.key ?? (stdin.isTTY ? await askHiddenKey() : undefined);
	if (key === undefined) {
		throw new Error("provide a gateway key with --key when stdin is not a TTY");
	}
	const settings = await readSettings();
	const catalog = await fetchMagpieCatalog(root, key);
	if (catalog.length === 0) throw new Error("remote magpie returned an empty model catalog; cannot choose a model");
	const model = await chooseMainModel(catalog, getSetting(settings, "model"), parsed.values.model);
	const fastModel = await chooseFastModel(catalog, model, parsed.values["fast-model"]);
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	if (typeof packageJson.version !== "string") throw new Error("package.json has no version");
	const version = packageJson.version;
	const result = await saveLoginSettings({
		root,
		key,
		catalog,
		model,
		fastModel,
		noStatusline: parsed.flags.has("no-statusline"),
		version,
	});
	console.log(`Connected to: ${root}`);
	console.log(`Gateway key: ${maskGatewayKey(key)}`);
	console.log(`Main model: ${model}`);
	console.log(`Fast/background model: ${fastModel}`);
	console.log(`Models available: ${catalog.length}`);
	if (result.hasCustomStatusLine) {
		console.log(`Your statusLine was left unchanged; call node "${path.join(result.libDir, "cli.mjs")}" statusline from your script to show Magpie usage.`);
	}
	if (result.hasCustomModelPicker) {
		console.log("Your modelPicker was left unchanged; remove it to let magpie-remote list gateway models in /model.");
	}
	console.log("Restart Claude Code; Magpie models appear in /model.");
}

/** @param {string[]} args */
async function status(args) {
	if (args.length > 0) throw new Error("status takes no arguments");
	const settings = await readSettings();
	const connection = resolveConnection(settings);
	const model = getSetting(settings, "model");
	if (!connection.root) {
		console.log("Not connected to a remote Magpie gateway.");
		return;
	}
	const root = normalizeMagpieUrl(connection.root);
	console.log(`Root: ${root}`);
	console.log(`Gateway key: ${maskGatewayKey(connection.key)}`);
	console.log(`Model: ${typeof model === "string" ? model : "(not set)"}`);
	try {
		const catalog = await fetchMagpieCatalog(root, connection.key, AbortSignal.timeout(4000));
		console.log(`Live check: ${catalog.length} models available`);
	} catch (error) {
		console.log(`Live check failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * @param {string[]} args
 * @param {boolean} noFail
 */
async function usage(args, noFail) {
	try {
		const settings = await readSettings();
		const connection = resolveConnection(settings);
		if (!connection.root) throw new Error("not connected to a remote Magpie gateway");
		const root = normalizeMagpieUrl(connection.root);
		const quotas = await fetchMagpieQuotas(root, connection.key);
		const filters = args.filter((arg) => arg !== "--json" && arg !== "--no-fail").map((arg) => arg.toLowerCase());
		const shown = filters.length
			? quotas.filter(
					(quota) =>
						filters.includes(quotaProviderOf(quota.provider)) ||
						filters.includes(quota.name.toLowerCase()) ||
						filters.includes(quota.kind.toLowerCase()),
				)
			: quotas;
		if (args.includes("--json")) console.log(JSON.stringify(shown, null, 2));
		else console.log(formatQuotaReport(shown));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (noFail) console.log(`Error: ${message}`);
		else throw error;
	}
}

/** @param {string[]} args */
async function logout(args) {
	if (args.length > 0) throw new Error("logout takes no arguments");
	if (await logoutSettings()) console.log("Logged out from remote Magpie.");
	else console.log("Not logged in to remote Magpie.");
}

/**
 * @param {string[]} args
 */
async function dispatch(args) {
	const [command, ...rest] = args;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(HELP);
		return;
	}
	if (command === "login") return login(rest);
	if (command === "status") return status(rest);
	if (command === "usage") {
		const noFail = rest.includes("--no-fail");
		return usage(rest, noFail);
	}
	if (command === "logout") return logout(rest);
	if (command === "sync") {
		await syncLibrary();
		return;
	}
	if (command === "statusline") {
		await runStatusLine();
		return;
	}
	throw new Error(`unknown command: ${command}\n\n${HELP}`);
}

/** @param {string[]} [args] */
export async function main(args = process.argv.slice(2)) {
	try {
		await dispatch(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}

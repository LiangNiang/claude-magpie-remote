// @ts-check

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BIN = path.resolve("bin/magpie-remote");

/**
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void} handler
 */
export async function startServer(handler) {
	const server = createServer(handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake Magpie server did not bind a TCP port");
	return { root: `http://127.0.0.1:${address.port}`, server };
}

/** @param {import("node:http").Server} server */
export async function closeServer(server) {
	server.close();
	if (typeof server.closeAllConnections === "function") server.closeAllConnections();
	await once(server, "close");
}

/** @returns {Promise<string>} */
export async function temporaryConfigDir() {
	return mkdtemp(path.join(os.tmpdir(), "claude-magpie-remote-"));
}

/** @param {string} directory */
export async function removeTemporaryDir(directory) {
	await rm(directory, { recursive: true, force: true });
}

/**
 * @param {string} configDir
 * @param {string[]} args
 * @param {string} [stdinText]
 * @param {NodeJS.ProcessEnv} [extraEnv]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runCli(configDir, args, stdinText = "", extraEnv = {}) {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...extraEnv };
	delete env.ANTHROPIC_BASE_URL;
	delete env.ANTHROPIC_AUTH_TOKEN;
	const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdin.end(stdinText);
	const [code] = await once(child, "close");
	return { code: typeof code === "number" ? code : 1, stdout, stderr };
}

/** @param {import("node:http").ServerResponse} response @param {unknown} value */
export function sendJson(response, value) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

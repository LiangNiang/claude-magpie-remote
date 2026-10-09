// @ts-check

import http from "node:http";
import https from "node:https";

/**
 * @param {string} url
 * @param {{ headers?: import("node:http").OutgoingHttpHeaders, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export function getJson(url, { headers = {}, timeoutMs } = {}) {
	return new Promise((resolve, reject) => {
		let target;
		try {
			target = new URL(url);
		} catch (error) {
			reject(error);
			return;
		}
		const client = target.protocol === "http:" ? http : target.protocol === "https:" ? https : undefined;
		if (!client) {
			reject(new Error(`unsupported protocol: ${target.protocol}`));
			return;
		}

		let settled = false;
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		/** @param {Error} error */
		const finishReject = (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(error);
		};
		/** @param {{ status: number, body: unknown }} result */
		const finishResolve = (result) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		const request = client.request(target, { method: "GET", headers }, (response) => {
			const status = response.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				response.once("error", finishReject);
				response.once("end", () => finishResolve({ status, body: undefined }));
				response.resume();
				return;
			}

			/** @type {Buffer[]} */
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.once("error", finishReject);
			response.once("end", () => {
				try {
					finishResolve({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
				} catch {
					const error = new Error(`invalid JSON from ${url}`);
					error.name = "InvalidJsonError";
					finishReject(error);
				}
			});
		});
		request.once("error", finishReject);
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				const error = new Error(`request to ${target.origin} timed out`);
				error.name = "TimeoutError";
				request.destroy(error);
				finishReject(error);
			}, timeoutMs);
		}
		request.end();
	});
}

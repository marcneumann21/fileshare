/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { AwsClient } from "aws4fetch";

// time after which a file is being deleted if it was never downloaded
const NOT_DOWNLOADED_MS = 60 * 60 * 1000;
// time after which a file is being deleted if it was downloaded
const AFTER_DOWNLOAD_MS = 7 * 24 * 60 * 60 * 1000;

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/u") {
			const { name, password } = await request.json();

			if (password !== env.UPLOAD_PASSWORD) {
				return new Response("Falsches Passwort", { status: 401 });
			}

			const date = new Date().toISOString().slice(0, 10);
			const key = `${date}_${crypto.randomUUID()}/${encodeURIComponent(name)}`;

			const r2 = new AwsClient({
				accessKeyId: env.R2_ACCESS_KEY_ID,
				secretAccessKey: env.R2_SECRET_ACCESS_KEY,
				service: "s3",
				region: "auto",
			});

			const target = new URL(
				`https://${env.BUCKET_NAME}.${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`
			);
			// expire link after 5 minutes
			target.searchParams.set("X-Amz-Expires", "300");

			const signed = await r2.sign(new Request(target, { method: "PUT" }), {
				aws: { signQuery: true },
			});

			return Response.json({
				uploadUrl: signed.url,
				downloadUrl: `${url.origin}/d/${key}`,
			});
		}

		if (request.method === "GET" && url.pathname.startsWith("/d/")) {
			const key = decodeURIComponent(url.pathname.slice(3));
			if (key.startsWith("_dl/")) return new Response("Kein Download-Link", { status: 404 });
			const now = Date.now();

			const info = await env.FILESHARE_BUCKET.head(key);
			if (!info) {
				return new Response("Nicht gefunden", { status: 404 });
			}

			const marker = await env.FILESHARE_BUCKET.head(`_dl/${key}`);
			const expired = marker ? now - marker.uploaded.getTime() > AFTER_DOWNLOAD_MS : now - info.uploaded.getTime() > NOT_DOWNLOADED_MS;

			if (expired) {
				return new Response("Abgelaufen", { status: 404 });
			}

			const obj = await env.FILESHARE_BUCKET.get(key);
			if (!obj) {
				return new Response("Nicht gefunden oder abgelaufen", { status: 404 });
			}

			const fileName = encodeURIComponent(key.split("/")[1]);
			const headers = new Headers();
			obj.writeHttpMetadata(headers);
			headers.set("content-disposition", `attachment; filename*=UTF-8''${fileName}`);

			// Durchreichen; beim ERSTEN vollständigen Download Markierung setzen
			const { readable, writable } = new TransformStream();
			ctx.waitUntil(
				obj.body.pipeTo(writable).then(() => {
					if (!marker) return env.FILESHARE_BUCKET.put(`_dl/${key}`, "");
				})
			);
			return new Response(readable, { headers });
		}

		return new Response("Not found", { status: 404 });
	},

	async scheduled(event, env, ctx) {
		const now = Date.now();

		// collect all objects in the bucket
		const all = [];
		let cursor;
		do {
			const list = await env.FILESHARE_BUCKET.list({ cursor });
			// ...
			all.push(...list.objects);
			cursor = list.truncated ? list.cursor : undefined;
		} while (cursor);

		// get the downloaded files
		const downloaded = new Set(
			all.filter((o) => o.key.startsWith("_dl/")).map((o) => o.key.slice(4))
		);

		const toDelete = [];
		for (const o of all) {
			const age = now - o.uploaded.getTime();

			if (o.key.startsWith("_dl/")) {
				// if downloaded, delete after 1 week
				if (age > AFTER_DOWNLOAD_MS) toDelete.push(o.key, o.key.slice(4));
			} else if (!downloaded.has(o.key) && age > NOT_DOWNLOADED_MS) {
				// if never downloaded, delete after 1 hour
				toDelete.push(o.key);
			}
		}

		// delete in batches of 1000 for efficiency
		for (let i = 0; i < toDelete.length; i += 1000) {
			await env.FILESHARE_BUCKET.delete(toDelete.slice(i, i + 1000));
		}
	},
};
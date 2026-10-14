import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;
const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;
// Threads only embeds post data in the HTML for crawlers.
const CRAWLER_USER_AGENT =
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

// ── Types ────────────────────────────────────────────────────────────

interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

// ── PDF Extraction ───────────────────────────────────────────────────

function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

async function extractPDF(
	buffer: ArrayBuffer,
	url: string,
): Promise<FetchResult> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));

	const metadata = await pdf.getMetadata();
	const metadataInfo =
		metadata.info && typeof metadata.info === "object"
			? (metadata.info as Record<string, unknown>)
			: null;

	const metaTitle =
		typeof metadataInfo?.Title === "string"
			? metadataInfo.Title.trim()
			: "";
	const metaAuthor =
		typeof metadataInfo?.Author === "string"
			? metadataInfo.Author.trim()
			: "";

	let urlTitle = "document";
	try {
		const { basename } = await import("node:path");
		urlTitle =
			basename(new URL(url).pathname, ".pdf")
				.replace(/[_-]+/g, " ")
				.trim() || "document";
	} catch {
		/* ignore */
	}
	const title = metaTitle || urlTitle;

	const maxPages = Math.min(pdf.numPages, 100);
	const pages: string[] = [];
	for (let i = 1; i <= maxPages; i++) {
		const page = await pdf.getPage(i);
		const textContent = await page.getTextContent();
		const pageText = textContent.items
			.map((item: unknown) => (item as { str?: string }).str || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (pageText) pages.push(pageText);
	}

	const lines: string[] = [
		`# ${title}`,
		"",
		`> Source: ${url}`,
		`> Pages: ${pdf.numPages}${pdf.numPages > maxPages ? ` (extracted first ${maxPages})` : ""}`,
	];
	if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
	lines.push("", "---", "");
	lines.push(pages.join("\n\n"));

	if (pdf.numPages > maxPages) {
		lines.push(
			"",
			"---",
			"",
			`*[Truncated: Only first ${maxPages} of ${pdf.numPages} pages extracted]*`,
		);
	}

	return { url, title, content: lines.join("\n"), error: null };
}

// ── RSC Content Extraction (Next.js) ─────────────────────────────────

function extractRSCContent(
	html: string,
): { title: string; content: string } | null {
	if (!html.includes("self.__next_f.push")) return null;

	const chunkMap = new Map<string, string>();
	const scriptRegex =
		/<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;

	for (const match of html.matchAll(scriptRegex)) {
		let content: string;
		try {
			content = JSON.parse('"' + match[1] + '"');
		} catch {
			continue;
		}
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			const colonIdx = line.indexOf(":");
			if (colonIdx <= 0 || colonIdx > 4) continue;
			const id = line.slice(0, colonIdx);
			if (!/^[0-9a-f]+$/i.test(id)) continue;
			const payload = line.slice(colonIdx + 1);
			if (!payload) continue;
			const existing = chunkMap.get(id);
			if (!existing || payload.length > existing.length) {
				chunkMap.set(id, payload);
			}
		}
	}

	if (chunkMap.size === 0) return null;

	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
	const title = titleMatch?.[1]?.split("|")[0]?.trim() || "";

	const parsedCache = new Map<string, unknown>();
	function getParsedChunk(id: string): unknown | null {
		if (parsedCache.has(id)) return parsedCache.get(id);
		const chunk = chunkMap.get(id);
		if (!chunk || !chunk.startsWith("[")) {
			parsedCache.set(id, null);
			return null;
		}
		try {
			const parsed = JSON.parse(chunk);
			parsedCache.set(id, parsed);
			return parsed;
		} catch {
			parsedCache.set(id, null);
			return null;
		}
	}

	type Node = unknown;
	const visitedRefs = new Set<string>();

	function extractNode(node: Node, ctx = { inCode: false }): string {
		if (node === null || node === undefined) return "";
		if (typeof node === "string") {
			const refMatch = node.match(/^\$L([0-9a-f]+)$/i);
			if (refMatch) {
				const refId = refMatch[1];
				if (visitedRefs.has(refId)) return "";
				visitedRefs.add(refId);
				const refNode = getParsedChunk(refId);
				const result = refNode ? extractNode(refNode, ctx) : "";
				visitedRefs.delete(refId);
				return result;
			}
			if (
				!ctx.inCode &&
				(node === "$undefined" ||
					node === "$" ||
					/^\$[A-Z]/.test(node))
			)
				return "";
			return node.trim() ? node : "";
		}
		if (typeof node === "number") return String(node);
		if (typeof node === "boolean") return "";
		if (!Array.isArray(node)) return "";

		if (node[0] === "$" && typeof node[1] === "string") {
			const tag = node[1] as string;
			const props = (node[3] || {}) as Record<string, unknown>;
			const skipTags = [
				"script", "style", "svg", "path", "circle", "link", "meta",
				"template", "button", "input", "nav", "footer", "aside",
			];
			if (skipTags.includes(tag)) return "";

			if (tag.startsWith("$L")) {
				const refId = tag.slice(2);
				if (visitedRefs.has(refId)) return "";
				if (props.baseId && props.children)
					return `## ${String(props.children)}\n\n`;
				visitedRefs.add(refId);
				const refNode = getParsedChunk(refId);
				let result = "";
				if (refNode) result = extractNode(refNode, ctx);
				else if (props.children)
					result = extractNode(props.children as Node, ctx);
				visitedRefs.delete(refId);
				return result;
			}

			const children = props.children;
			const content = children
				? extractNode(children as Node, ctx)
				: "";

			switch (tag) {
				case "h1": return `# ${content.trim()}\n\n`;
				case "h2": return `## ${content.trim()}\n\n`;
				case "h3": return `### ${content.trim()}\n\n`;
				case "h4": return `#### ${content.trim()}\n\n`;
				case "h5": return `##### ${content.trim()}\n\n`;
				case "h6": return `###### ${content.trim()}\n\n`;
				case "p": return `${content.trim()}\n\n`;
				case "code": {
					const cc = children
						? extractNode(children as Node, { inCode: true })
						: "";
					return ctx.inCode ? cc : `\`${cc}\``;
				}
				case "pre": {
					const pc = children
						? extractNode(children as Node, { inCode: true })
						: "";
					return "```\n" + pc + "\n```\n\n";
				}
				case "strong": case "b": return `**${content}**`;
				case "em": case "i": return `*${content}*`;
				case "li": return `- ${content.trim()}\n`;
				case "ul": case "ol": return content + "\n";
				case "blockquote": return `> ${content.trim()}\n\n`;
				case "a": {
					const href = props.href as string | undefined;
					return href && !href.startsWith("#")
						? `[${content}](${href})`
						: content;
				}
				default: return content;
			}
		}

		return (node as Node[]).map((n) => extractNode(n, ctx)).join("");
	}

	const mainChunk = getParsedChunk("23");
	if (mainChunk) {
		const content = extractNode(mainChunk);
		if (content.trim().length > 100) {
			return {
				title,
				content: content.replace(/\n{3,}/g, "\n\n").trim(),
			};
		}
	}

	const contentParts: { order: number; text: string }[] = [];
	for (const [id] of chunkMap) {
		if (id === "23") continue;
		const parsed = getParsedChunk(id);
		if (!parsed) continue;
		visitedRefs.clear();
		const text = extractNode(parsed);
		if (
			text.trim().length > 50 &&
			!text.includes("page was not found") &&
			!text.includes("404")
		) {
			contentParts.push({
				order: parseInt(id, 16),
				text: text.trim(),
			});
		}
	}

	if (contentParts.length === 0) return null;
	contentParts.sort((a, b) => a.order - b.order);

	const seen = new Set<string>();
	const uniqueParts: string[] = [];
	for (const part of contentParts) {
		const key = part.text.slice(0, 150);
		if (!seen.has(key)) {
			seen.add(key);
			uniqueParts.push(part.text);
		}
	}

	const content = uniqueParts
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return content.length > 100 ? { title, content } : null;
}

// ── Threads Extraction ───────────────────────────────────────────────

type Json = Record<string, any>;

function isThreadsPostUrl(url: string): boolean {
	try {
		const { hostname, pathname } = new URL(url);
		return (
			/(^|\.)threads\.(com|net)$/.test(hostname) &&
			/\/(post|share)\//.test(pathname)
		);
	} catch {
		return false;
	}
}

function quote(text: string): string {
	return text
		.split("\n")
		.map((l) => (l ? `> ${l}` : ">"))
		.join("\n");
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function collectThreadsData(html: string): {
	posts: Json[];
	threadInfos: { ownerId: unknown; info: Json }[];
} {
	const posts: Json[] = [];
	const threadInfos: { ownerId: unknown; info: Json }[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const obj = node as Json;
		if (obj.caption !== undefined && obj.user?.username && obj.code) {
			posts.push(obj);
		}
		const info = obj.text_post_app_info;
		if (
			info &&
			(info.direct_replies || info.self_thread || info.pinned_replies)
		) {
			threadInfos.push({ ownerId: obj.id, info });
		}
		for (const value of Object.values(obj)) walk(value);
	};

	const scriptRegex =
		/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
	for (const match of html.matchAll(scriptRegex)) {
		if (!match[1].includes('"caption"')) continue;
		try {
			walk(JSON.parse(match[1]));
		} catch {
			/* ignore malformed blocks */
		}
	}
	return { posts, threadInfos };
}

function threadEdgeNodes(connection: Json | undefined): Json[][] {
	// direct_replies / pinned_replies: edges[].node.posts.edges[].node
	// The first post of each group is the reply, the rest are its inline sub-replies.
	return (connection?.edges ?? []).map((edge: Json) =>
		(edge?.node?.posts?.edges ?? [])
			.map((e: Json) => e?.node)
			.filter(Boolean),
	);
}

function formatThreadsPost(post: Json): string {
	const info = post.text_post_app_info ?? {};
	const meta = [`**@${post.user.username}**`];
	if (post.taken_at) {
		meta.push(
			new Date(post.taken_at * 1000)
				.toISOString()
				.slice(0, 16)
				.replace("T", " ") + " UTC",
		);
	}
	if (typeof post.like_count === "number")
		meta.push(plural(post.like_count, "like"));
	if (info.direct_reply_count)
		meta.push(plural(info.direct_reply_count, "reply", "replies"));
	if (info.repost_count) meta.push(plural(info.repost_count, "repost"));

	const lines = [meta.join(" · "), "", post.caption?.text?.trim() || ""];

	const media: string[] = [];
	const addMedia = (m: Json) => {
		const video = m?.video_versions?.[0]?.url;
		const image = m?.image_versions2?.candidates?.[0]?.url;
		if (video) media.push(`- Video: ${video}`);
		else if (image) media.push(`- Image: ${image}`);
	};
	if (Array.isArray(post.carousel_media)) post.carousel_media.forEach(addMedia);
	else addMedia(post);
	const link = info.link_preview_attachment?.url;
	if (link) media.push(`- Link: ${link}`);
	if (media.length) lines.push("", ...media);

	const quoted = info.share_info?.quoted_post;
	if (quoted?.user?.username) {
		lines.push("", quote(formatThreadsPost(quoted)));
	}
	return lines.join("\n").trim();
}

function extractThreadsContent(
	html: string,
	pageUrl: string,
): { title: string; content: string } | null {
	const code = new URL(pageUrl).pathname.match(/\/post\/([^/?#]+)/)?.[1];
	if (!code) return null;

	const { posts, threadInfos } = collectThreadsData(html);
	const main = posts.find((p) => p.code === code);
	if (!main) return null;
	// Only use reply data that belongs to the main post.
	const mainInfos = threadInfos
		.filter((t) => main.id != null && t.ownerId === main.id)
		.map((t) => t.info);

	const seen = new Set<string>([main.code]);
	const fresh = (p: Json) => {
		if (!p?.code || !p.user?.username || seen.has(p.code)) return false;
		seen.add(p.code);
		return true;
	};

	const selfThread: Json[] = [];
	const replyGroups: Json[][] = [];
	for (const info of mainInfos) {
		for (const e of info.self_thread?.posts?.edges ?? []) {
			if (fresh(e?.node)) selfThread.push(e.node);
		}
	}
	for (const key of ["pinned_replies", "direct_replies"]) {
		for (const info of mainInfos) {
			for (const group of threadEdgeNodes(info[key])) {
				// Skip the whole group if its head reply was already shown (e.g. pinned).
				if (!group.length || !fresh(group[0])) continue;
				replyGroups.push([group[0], ...group.slice(1).filter(fresh)]);
			}
		}
	}

	const sections = [formatThreadsPost(main)];
	if (selfThread.length) {
		const [first, ...rest] = selfThread.map(formatThreadsPost);
		sections.push(`## Thread continuation\n\n${first}`, ...rest);
	}
	const total = main.text_post_app_info?.direct_reply_count;
	const replies = replyGroups.map(([reply, ...subReplies]) =>
		[
			formatThreadsPost(reply),
			...subReplies.map((sub) => quote(formatThreadsPost(sub))),
		].join("\n\n"),
	);
	if (replies.length) {
		const heading = `## Replies (${replies.length} shown${total ? ` of ${total}` : ""})`;
		sections.push(`${heading}\n\n${replies[0]}`, ...replies.slice(1));
	}

	const firstLine = (main.caption?.text || "").split("\n")[0].trim();
	const title = `@${main.user.username} on Threads${firstLine ? `: ${Array.from(firstLine).slice(0, 80).join("")}` : ""}`;
	return { title, content: sections.join("\n\n---\n\n") };
}

async function extractThreads(
	url: string,
	signal?: AbortSignal,
): Promise<FetchResult | null> {
	try {
		// The crawler UA also makes /share/ links redirect to the post URL.
		const res = await fetch(url, {
			headers: {
				"User-Agent": CRAWLER_USER_AGENT,
				"Accept-Language": "en-US,en;q=0.9",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});
		if (!res.ok) return null;
		const result = extractThreadsContent(await res.text(), res.url);
		if (!result) return null;
		const finalUrl = new URL(res.url);
		finalUrl.search = "";
		return { url: finalUrl.toString(), ...result, error: null };
	} catch {
		return null;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const textContent = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return textContent.length < 500 && scriptCount > 3;
}

function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

// ── Jina Reader Fallback ─────────────────────────────────────────────

async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
): Promise<FetchResult | null> {
	try {
		const res = await fetch(JINA_READER_BASE + url, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: AbortSignal.any([
				AbortSignal.timeout(JINA_TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});
		if (!res.ok) return null;

		const content = await res.text();
		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) return null;

		const markdownPart = content.slice(contentStart + 17).trim();
		if (
			markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")
		) {
			return null;
		}

		const title =
			extractHeadingTitle(markdownPart) ??
			new URL(url).pathname.split("/").pop() ??
			url;
		return { url, title, content: markdownPart, error: null };
	} catch {
		return null;
	}
}

// ── Main HTTP Extraction ─────────────────────────────────────────────

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
): Promise<FetchResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		if (!response.ok) {
			return {
				url, title: "", content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentType = response.headers.get("content-type") || "";
		const contentLengthHeader = response.headers.get("content-length");
		const isPDFContent = isPDF(url, contentType);
		const maxSize = isPDFContent ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE;

		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxSize) {
				return {
					url, title: "", content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (isPDFContent) {
			const buffer = await response.arrayBuffer();
			return await extractPDF(buffer, url);
		}

		if (
			contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")
		) {
			return {
				url, title: "", content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await response.text();
		const isHTML =
			contentType.includes("text/html") ||
			contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			const title =
				extractHeadingTitle(text) ??
				new URL(url).pathname.split("/").pop() ??
				url;
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				return {
					url,
					title: rscResult.title,
					content: rscResult.content,
					error: null,
				};
			}

			const jsRendered = isLikelyJSRendered(text);
			return {
				url, title: "", content: "",
				error: jsRendered
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Could not extract readable content from HTML structure",
			};
		}

		const markdown = turndown.turndown(article.content);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
			};
		}

		return {
			url,
			title: article.title || "",
			content: markdown,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ── Public Fetch Function ────────────────────────────────────────────

async function fetchAndExtract(
	url: string,
	signal?: AbortSignal,
): Promise<FetchResult> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	if (isThreadsPostUrl(url)) {
		const threadsResult = await extractThreads(url, signal);
		if (threadsResult) return threadsResult;
		if (signal?.aborted)
			return { url, title: "", content: "", error: "Aborted" };
	}

	const httpResult = await extractViaHttp(url, signal);
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };
	if (!httpResult.error) return httpResult;

	if (
		httpResult.error.startsWith("Unsupported content type") ||
		httpResult.error.startsWith("Response too large")
	) {
		return httpResult;
	}

	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;
	if (signal?.aborted)
		return { url, title: "", content: "", error: "Aborted" };

	return {
		...httpResult,
		error: `${httpResult.error}\n\nThe page may be JavaScript-rendered. Try:\n  • A different URL for the same content\n  • web_search to find cached/alternative versions`,
	};
}

// ── Extension Registration ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract readable content as clean markdown. Uses Readability + Turndown for high-quality HTML→markdown conversion. Handles PDFs, plain text, and falls back to Jina Reader for JS-rendered pages.",
		promptSnippet:
			"Fetch a URL and extract readable content as markdown. Supports HTML pages, PDFs, and plain text.",

		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await fetchAndExtract(params.url, signal);

			if (result.error) {
				throw new Error(`${params.url}: ${result.error}`);
			}

			const header = result.title
				? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
				: "";
			return {
				content: [
					{
						type: "text" as const,
						text: header + result.content,
					},
				],
				details: {
					url: result.url,
					title: result.title,
					chars: result.content.length,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { url } = args as { url?: string };
			if (!url) {
				text.setText(
					theme.fg("toolTitle", theme.bold("fetch ")) +
						theme.fg("error", "(no URL)"),
				);
				return text;
			}
			const display =
				url.length > 70 ? url.slice(0, 67) + "..." : url;
			text.setText(
				theme.fg("toolTitle", theme.bold("fetch ")) +
					theme.fg("accent", display),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Fetching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				title?: string;
				chars?: number;
			};

			const title = details?.title || "Untitled";
			const chars = details?.chars ?? 0;
			const status =
				theme.fg("success", title) +
				theme.fg("muted", ` (${chars} chars)`);

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500
					? content.slice(0, 500) + "..."
					: content;
			text.setText(status + "\n" + theme.fg("dim", preview));
			return text;
		},
	});
}

/*
Test-only, verbatim upstream excerpt: object/replayState + Messages translate.
Source: https://unpkg.com/@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2/lib/index.js
Package: @deepseek-ai/dsh-llm-deepseek 0.2.1-rc.2
Archive: https://registry.npmjs.org/@deepseek-ai/dsh-llm-deepseek/-/dsh-llm-deepseek-0.2.1-rc.2.tgz
Archive integrity: sha512-CxWvAB8FwnTJTZE7b5k0A3sAmC4mq2UJZNSsSNn7lWsquCcPoTvsR37UDo8ec352oBbYzrw+f9+h91oYLfhmqQ==

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Inject the real SDK LlmError/ToolCallId without loading a provider or credentials.
export function createTranslate(LlmError, ToolCallId) {
// BEGIN UPSTREAM
function object(value, code = "MALFORMED_RESPONSE") {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LlmError("DeepSeek Messages expected a JSON object", code);
	return value;
}
/** Construct response metadata without duplicating the assistant text.
* @param model - requested model identity.
* @param blocks - metadata in emitted block order.
* @returns the versioned envelope persisted by the existing assembler.
*/
function replayState(model, blocks) {
	return {
		response: {
			kind: "deepseek-messages",
			version: 1,
			model
		},
		blocks
	};
}
//#region lib/types/translate.js
/** Translate Messages events while preserving block order and cumulative usage. */
/** Decode a required string from provider JSON.
* @param value - provider field.
* @returns the validated string.
*/
function string(value) {
	if (typeof value !== "string") throw new LlmError("DeepSeek Messages expected a string field", "MALFORMED_RESPONSE");
	return value;
}
function malformed(detail) {
	throw new LlmError(`DeepSeek Messages stream: ${detail}`, "MALFORMED_RESPONSE");
}
function indexOf(event) {
	if (!Number.isSafeInteger(event.index) || event.index < 0) return malformed("invalid block index");
	return event.index;
}
function updateUsage(usage, raw) {
	const fields = object(raw);
	for (const [wire, local] of Object.entries({
		input_tokens: "inputTokens",
		output_tokens: "outputTokens",
		cache_read_input_tokens: "cacheReadTokens",
		cache_creation_input_tokens: "cacheWriteTokens"
	})) {
		const value = fields[wire];
		if (value === void 0) continue;
		if (!Number.isSafeInteger(value) || value < 0) return malformed(`invalid ${wire}`);
		usage[local] = value;
	}
}
function startBlock(event, index) {
	const native = object(event.content_block);
	let content;
	let replay;
	switch (native.type) {
		case "text":
			content = {
				type: "text",
				text: string(native.text)
			};
			replay = { type: "text" };
			break;
		case "thinking":
			content = {
				type: "reasoning",
				text: string(native.thinking)
			};
			replay = {
				type: "reasoning",
				...native.signature === void 0 ? {} : { signature: string(native.signature) }
			};
			break;
		case "tool_use":
			content = {
				type: "tool-call",
				id: ToolCallId(string(native.id)),
				name: string(native.name),
				arguments: JSON.stringify(object(native.input))
			};
			if (!content.id || !content.name) return malformed("empty tool identity");
			replay = { type: "tool-call" };
			break;
		default: throw new LlmError(`DeepSeek Messages does not support response block ${String(native.type)}`, "UNSUPPORTED_CONTENT");
	}
	return {
		index,
		content,
		replay,
		closed: false,
		json: ""
	};
}
function deltaChunk(block, raw) {
	const delta = object(raw);
	const content = block.content;
	if (delta.type === "text_delta" && content.type === "text") {
		const text = string(delta.text);
		content.text += text;
		return {
			type: "text-delta",
			index: block.index,
			text
		};
	}
	if (delta.type === "thinking_delta" && content.type === "reasoning") {
		const text = string(delta.thinking);
		content.text += text;
		return {
			type: "reasoning-delta",
			index: block.index,
			text
		};
	}
	if (delta.type === "signature_delta" && content.type === "reasoning") {
		block.replay.signature = (block.replay.signature ?? "") + string(delta.signature);
		return;
	}
	if (delta.type === "input_json_delta" && content.type === "tool-call") {
		const argumentsDelta = string(delta.partial_json);
		block.json += argumentsDelta;
		return {
			type: "tool-call-delta",
			index: block.index,
			id: content.id,
			argumentsDelta
		};
	}
	return malformed(`unsupported delta ${String(delta.type)} for ${content.type}`);
}
function stopReason(raw) {
	switch (raw) {
		case "end_turn":
		case "stop_sequence": return { kind: "stop" };
		case "tool_use": return { kind: "tool-calls" };
		case "max_tokens": return { kind: "max-tokens" };
		default: return malformed(`unsupported stop reason ${String(raw)}`);
	}
}
/** Translate decoded SSE data into the Harness stream protocol.
* @param events - framed, decoded provider events in arrival order.
* @param model - requested model id stored in durable replay state.
* @returns blocks, one final usage value, and exactly one terminal finish.
*/
async function* translate(events, model) {
	const blocks = /* @__PURE__ */ new Map();
	const usage = {
		inputTokens: 0,
		outputTokens: 0
	};
	let started = false;
	let reason;
	for await (const event of events) {
		if (event.type === "message_start") {
			if (started) return malformed("duplicate message_start");
			updateUsage(usage, object(event.message).usage);
			started = true;
			continue;
		}
		if (![
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop"
		].includes(String(event.type))) continue;
		if (!started) return malformed("event precedes message_start");
		if (event.type === "content_block_start") {
			const wireIndex = indexOf(event);
			if (blocks.has(wireIndex) || reason !== void 0) return malformed("block starts after settlement or repeats an index");
			const block = startBlock(event, blocks.size);
			blocks.set(wireIndex, block);
			yield {
				type: "block-start",
				index: block.index,
				blockType: block.content.type
			};
			if (block.content.type === "text" || block.content.type === "reasoning") {
				if (block.content.text) yield {
					type: block.content.type === "text" ? "text-delta" : "reasoning-delta",
					index: block.index,
					text: block.content.text
				};
			} else yield {
				type: "tool-call-delta",
				index: block.index,
				id: block.content.id,
				name: block.content.name,
				argumentsDelta: ""
			};
		} else if (event.type === "content_block_delta" || event.type === "content_block_stop") {
			const block = blocks.get(indexOf(event));
			if (block === void 0 || block.closed) return malformed("delta/stop without an open block");
			if (event.type === "content_block_delta") {
				const chunk = deltaChunk(block, event.delta);
				if (chunk !== void 0) yield chunk;
			} else {
				block.closed = true;
				if (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;
				yield {
					type: "block-end",
					index: block.index,
					block: { ...block.content }
				};
			}
		} else if (event.type === "message_delta") {
			const delta = object(event.delta);
			if (delta.stop_reason != null) reason = stopReason(delta.stop_reason);
			if (event.usage !== void 0) updateUsage(usage, event.usage);
		} else {
			if (reason === void 0 || [...blocks.values()].some((block) => !block.closed)) return malformed("message_stop without settled blocks and stop reason");
			if (blocks.size === 0 && reason.kind === "stop") throw new LlmError("DeepSeek Messages returned no content", "EMPTY_RESPONSE");
			if (reason.kind !== "max-tokens") for (const { content } of blocks.values()) {
				if (content.type !== "tool-call") continue;
				let parsed;
				try {
					parsed = JSON.parse(content.arguments);
				} catch (_invalidProviderToolJson) {
					return malformed("tool input is invalid JSON");
				}
				object(parsed);
			}
			usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			yield {
				type: "usage",
				usage
			};
			yield {
				type: "finish",
				reason,
				replayState: replayState(model, [...blocks.values()].map((block) => block.replay))
			};
			return;
		}
	}
	throw new LlmError("DeepSeek Messages stream ended before message_stop", "STREAM_CLOSED");
}
//#endregion
// END UPSTREAM
return translate;
}

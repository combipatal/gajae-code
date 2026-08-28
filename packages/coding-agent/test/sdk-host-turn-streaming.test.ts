import { describe, expect, test } from "bun:test";
import { mapAgentWireEventPayloadToAcpSessionUpdates } from "../src/modes/acp/acp-event-mapper";
import { toAgentWireEventPayload } from "../src/modes/shared/agent-wire/event-envelope";
import type { AgentSessionEvent } from "../src/session/agent-session";

/**
 * The SDK-only host streams turn content to the connections that submitted the
 * turn by sending the same frame the notifications runtime sends:
 *
 *   { type: "event", kind: event.type, payload: toAgentWireEventPayload(event), ...correlation }
 *
 * Two properties make that frame usable by an ACP client, and both are easy to
 * break silently:
 *
 * - `payload.event` must be present, because that nested key is the only thing
 *   the ACP receiver keys on to decide a frame carries mappable content. A
 *   payload shaped any other way is delivered and then silently ignored.
 * - the payload must map to real session updates, so the client renders
 *   assistant text and tool calls instead of an empty turn.
 */

const SESSION_ID = "01a04638-0f98-73ee-b0a6-f6eac6bc8ee5";

/** The exact frame `streamTurnEvent` builds in sdk/host/session-runtime.ts. */
function streamedFrame(event: AgentSessionEvent, correlation: { commandId: string; turnId: string }) {
	return { type: "event", kind: event.type, payload: toAgentWireEventPayload(event), ...correlation };
}

const CORRELATION = {
	commandId: "b62529c0-91ab-4ee3-8025-62fbeb341ec5",
	turnId: "62f36efe-0d5e-430a-913a-2d37a4207c90",
};

function textDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: delta }] },
		assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
	} as unknown as AgentSessionEvent;
}

function thinkingDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "thinking", thinking: delta }] },
		assistantMessageEvent: { type: "thinking_delta", delta, contentIndex: 0 },
	} as unknown as AgentSessionEvent;
}

function toolStart(): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId: "call_1",
		toolName: "read",
		args: { path: "README.md" },
	} as unknown as AgentSessionEvent;
}

function toolEnd(): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "read",
		args: { path: "README.md" },
		result: { output: "hello" },
		isError: false,
	} as unknown as AgentSessionEvent;
}

describe("streamed turn frames", () => {
	test("carry the nested event key the ACP receiver keys on", () => {
		// `receivedSdkEvent` sets its wire payload only when `payload.event` is an
		// object; without it the frame arrives and produces no session update.
		for (const event of [textDelta("hi"), thinkingDelta("mm"), toolStart(), toolEnd()]) {
			const frame = streamedFrame(event, CORRELATION);
			expect(frame.type).toBe("event");
			expect(frame.kind).toBe(event.type);
			expect(frame.payload.event).toBeDefined();
			expect(frame.payload.event_type).toBeDefined();
		}
	});

	test("carry the submitting invocation's correlation so the client can attribute them", () => {
		const frame = streamedFrame(textDelta("hi"), CORRELATION);
		expect(frame.commandId).toBe(CORRELATION.commandId);
		expect(frame.turnId).toBe(CORRELATION.turnId);
	});

	test("assistant text becomes an agent message chunk", () => {
		const updates = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(textDelta("STREAM-OK"), CORRELATION).payload,
			SESSION_ID,
		);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "STREAM-OK" },
		});
		expect(updates[0]?.sessionId).toBe(SESSION_ID);
	});

	test("thinking becomes a thought chunk, not message text", () => {
		const updates = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(thinkingDelta("planning"), CORRELATION).payload,
			SESSION_ID,
		);
		expect(updates[0]?.update).toMatchObject({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "planning" },
		});
	});

	test("a tool call opens and then completes", () => {
		const started = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(toolStart(), CORRELATION).payload,
			SESSION_ID,
		);
		expect(started[0]?.update).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "call_1" });

		const ended = mapAgentWireEventPayloadToAcpSessionUpdates(
			streamedFrame(toolEnd(), CORRELATION).payload,
			SESSION_ID,
		);
		expect(ended[0]?.update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call_1",
			status: "completed",
		});
	});

	test("a non-assistant message produces no client update", () => {
		// The host echoes the user prompt and tool results through the same event,
		// and mirroring those back would duplicate the client's own transcript.
		const userMessage = {
			type: "message_update",
			message: { role: "user", content: [{ type: "text", text: "prompt" }] },
			assistantMessageEvent: { type: "text_delta", delta: "prompt", contentIndex: 0 },
		} as unknown as AgentSessionEvent;
		expect(
			mapAgentWireEventPayloadToAcpSessionUpdates(streamedFrame(userMessage, CORRELATION).payload, SESSION_ID),
		).toHaveLength(0);
	});
});

/**
 * Hub `send` rounds: runtime send→wait loop, Main binding wrap, abort/fail-closed.
 * Isolated after-yield failed-no-revive is skipped — see the last test's comment.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { executeSend } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import type { CoordinationDetails } from "@oh-my-pi/pi-coding-agent/tools/hub/types";

interface FakeSession {
	session: AgentSession;
	delivered: IrcMessage[];
	onDeliver: (fn: (msg: IrcMessage) => void) => void;
}

function makeFakeSession(): FakeSession {
	let deliverHook: ((msg: IrcMessage) => void) | undefined;
	const delivered: IrcMessage[] = [];
	const session = {
		isStreaming: true,
		subscribe: () => () => {},
		waitForIrcAutoReplies: async () => {},
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			deliverHook?.(msg);
			return "injected" as const;
		},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		onDeliver: fn => {
			deliverHook = fn;
		},
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

describe("hub send rounds", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("rounds:3 drives three exchanges then stop cap/done", async () => {
		const a = makeFakeSession();
		const b = makeFakeSession();
		registry.register({ id: "A", displayName: "task", kind: "sub", session: a.session });
		registry.register({ id: "B", displayName: "task", kind: "sub", session: b.session, status: "idle" });
		let n = 0;
		b.onDeliver(msg => {
			n++;
			void bus.send({ from: "B", to: msg.from, body: `pong-${n}`, replyTo: msg.id });
		});

		const sent = await executeSend(
			{ registry, senderId: "A", settings: Settings.isolated() },
			{ to: "B", message: "debate this", rounds: 3 },
		);
		const details = sent.details as CoordinationDetails;
		expect(sent.isError).toBeFalsy();
		expect(b.delivered).toHaveLength(3);
		expect(details.round).toBe(3);
		expect(details.of).toBe(3);
		expect(details.stopReason === "cap" || details.stopReason === "done").toBe(true);
		const text = textOf(sent);
		expect(text).toContain("round 3/3");
		expect(text).toMatch(/stopReason: (cap|done)/);
		expect(b.delivered.map(msg => msg.body)).toEqual([
			expect.stringContaining("round 1/3"),
			expect.stringContaining("round 2/3"),
			expect.stringContaining("round 3/3"),
		]);
		expect(b.delivered[0]?.body).not.toContain("<binding");
		expect(details.waited?.body).toBe("pong-3");
	});

	test("to:all with rounds>1 errors", async () => {
		registry.register({ id: "A", displayName: "task", kind: "sub", session: makeFakeSession().session });
		const sent = await executeSend(
			{ registry, senderId: "A", settings: Settings.isolated() },
			{ to: "all", message: "hello everyone", rounds: 3 },
		);
		expect(sent.isError).toBe(true);
		const details = sent.details as CoordinationDetails;
		expect(details.stopReason).toBe("failed");
		expect(textOf(sent)).toContain('to:"all"');
	});

	test("peer aborted mid-loop stops", async () => {
		const a = makeFakeSession();
		const b = makeFakeSession();
		registry.register({ id: "A", displayName: "task", kind: "sub", session: a.session });
		registry.register({ id: "B", displayName: "task", kind: "sub", session: b.session, status: "idle" });
		let n = 0;
		b.onDeliver(msg => {
			n++;
			if (n === 1) {
				void bus.send({ from: "B", to: msg.from, body: "pong-1", replyTo: msg.id });
				registry.setStatus("B", "aborted");
			}
		});

		const sent = await executeSend(
			{ registry, senderId: "A", settings: Settings.isolated() },
			{ to: "B", message: "keep going", rounds: 3 },
		);
		const details = sent.details as CoordinationDetails;
		expect(sent.isError).toBe(true);
		expect(b.delivered).toHaveLength(1);
		expect(details.round).toBeLessThan(3);
		expect(details.stopReason === "abort" || details.stopReason === "failed").toBe(true);
		expect(textOf(sent)).toMatch(/round \d\/3/);
		expect(textOf(sent)).toMatch(/stopReason: (abort|failed)/);
	});

	test("Main send wraps a binding block; sibling send does not", async () => {
		const child = makeFakeSession();
		const sibling = makeFakeSession();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: makeFakeSession().session,
		});
		registry.register({ id: "Child", displayName: "task", kind: "sub", session: child.session });
		registry.register({ id: "Sibling", displayName: "task", kind: "sub", session: sibling.session });

		await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
			{ to: "Child", message: "this is an order" },
		);
		expect(child.delivered[0]?.body).toContain('<binding from="Main">');
		expect(child.delivered[0]?.body).toContain("this is an order");
		expect(child.delivered[0]?.body).toContain("</binding>");

		await executeSend(
			{ registry, senderId: "Sibling", settings: Settings.isolated() },
			{ to: "Child", message: "sibling prose" },
		);
		expect(child.delivered[1]?.body).toBe("sibling prose");
	});

	test.skip("isolated after-yield failed send does not revive", () => {
		// Cheap stub of a yielded-then-failed peer (tombstone / no-revive) is not
		// available without the lifecycle+sessionFile park path. Skip rather than
		// invent a second bus or poke irc/bus.ts.
	});
});

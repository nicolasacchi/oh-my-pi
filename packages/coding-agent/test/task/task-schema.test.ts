import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting an optional
// fail-closed `model` (provider/id or @role; omit to inherit; literal `"default"`
// is rejected at preflight), `outputSchema`, and its validation mode. The batch
// shape (`tasks[]` + shared `context`) is gated by the `task.batch` setting
// (default on, covered by test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("accepts {agent, task}", () => {
		const parsed = taskSchema({ agent: "scout", task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("defaults agent to `task` when omitted", () => {
		const parsed = taskSchema({ task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.agent).toBe("task");
		}
	});

	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("retains caller outputSchema and schemaMode while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			outputSchema,
			schemaMode: "strict",
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});

	it("accepts an optional model selector and still strips stale keys", () => {
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			model: "@smol",
			role: "Rust specialist",
			description: "stale ui label",
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.model).toBe("@smol");
			expect("role" in parsed).toBe(false);
			expect("description" in parsed).toBe(false);
		}
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});

	it("rejects literal model default at preflight", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "General-purpose task agent",
					systemPrompt: "You are a task agent.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", {
			agent: "task",
			task: "Map the auth module.",
			model: "default",
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Omit the field to inherit");
	});
});

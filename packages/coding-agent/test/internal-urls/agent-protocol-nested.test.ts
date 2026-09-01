import { afterAll, afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";

const tempDir = TempDir.createSync("omp-nested-agent-repro-");
afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await fs.writeFile(path.join(midOwnArtifactsDir, `${grandchildId}.md`), "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});

it("agent:// slash form resolves a nested subagent child (hierarchy separator)", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "slash-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// Parent subagent adopts the root ArtifactManager; its own children are
	// written one level deeper under its sessionFile-derived dir, dot-qualified.
	const parentSessionFile = path.join(rootArtifactsDir, "Parent.jsonl");
	const parentOwnDir = parentSessionFile.slice(0, -6);
	await fs.mkdir(parentOwnDir, { recursive: true });
	await fs.writeFile(path.join(parentOwnDir, "Parent.Child.md"), "child capsule");
	// Parent output may be in the root dir; the nested child must still win.
	await fs.writeFile(path.join(rootArtifactsDir, "Parent.md"), JSON.stringify({ Child: "wrong base output" }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: parentSessionFile,
	});

	const handler = new AgentProtocolHandler();
	// Slash form is a hierarchy hop, not a jq extraction.
	const slash = await handler.resolve(new URL("agent://Parent/Child") as never);
	expect(slash.content).toBe("child capsule");
	expect(slash.contentType).toBe("text/markdown");
	// The canonical dotted id resolves to the same output.
	const dotted = await handler.resolve(new URL("agent://Parent.Child") as never);
	expect(dotted.content).toBe("child capsule");
});

it("agent:// path form falls back to JSON extraction when no nested output matches", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "json-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.md"), JSON.stringify({ result: { ok: true } }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	// `result` names no nested output, so the path extracts JSON from Worker.md.
	const extracted = await handler.resolve(new URL("agent://Worker/result") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toEqual({ ok: true });
});

it("agent:// resolvedModel extraction fills from parked history when yield JSON omits it", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "resolved-model-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	const yieldJson = { result: { data: { ok: true } }, resolvedModel: null };
	await fs.writeFile(path.join(rootArtifactsDir, "ThatId.md"), JSON.stringify(yieldJson));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "ThatId",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: null,
		status: "parked",
		sessionFile: path.join(rootArtifactsDir, "ThatId.jsonl"),
		history: { resolvedModel: "openrouter/foo:free" },
	});

	const handler = new AgentProtocolHandler();
	const extracted = await handler.resolve(new URL("agent://ThatId/resolvedModel") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toBe("openrouter/foo:free");

	const viaQuery = await handler.resolve(new URL("agent://ThatId?q=resolvedModel") as never);
	expect(JSON.parse(viaQuery.content)).toBe("openrouter/foo:free");
	const viaModel = await handler.resolve(new URL("agent://ThatId?q=model") as never);
	expect(JSON.parse(viaModel.content)).toBe("openrouter/foo:free");
	const viaOverride = await handler.resolve(new URL("agent://ThatId?q=modelOverride") as never);
	expect(JSON.parse(viaOverride.content)).toBe("openrouter/foo:free");

	const full = await handler.resolve(new URL("agent://ThatId") as never);
	expect(full.contentType).toBe("text/markdown");
	expect(JSON.parse(full.content)).toEqual(yieldJson);
});

it("agent:// resolvedModel extraction prefers yield JSON and nested child output over registry", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "resolved-model-precedence.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(path.join(rootArtifactsDir, "Yielded.md"), JSON.stringify({ resolvedModel: "yield/from-json" }));
	const parentOwnDir = path.join(rootArtifactsDir, "Parent");
	await fs.mkdir(parentOwnDir, { recursive: true });
	await fs.writeFile(path.join(parentOwnDir, "Parent.resolvedModel.md"), "child capsule");
	await fs.writeFile(path.join(rootArtifactsDir, "Parent.md"), JSON.stringify({}));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Yielded",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: null,
		status: "parked",
		history: { resolvedModel: "openrouter/foo:free" },
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: path.join(rootArtifactsDir, "Parent.jsonl"),
		history: { resolvedModel: "openrouter/foo:free" },
	});

	const handler = new AgentProtocolHandler();
	const fromYield = await handler.resolve(new URL("agent://Yielded/resolvedModel") as never);
	expect(JSON.parse(fromYield.content)).toBe("yield/from-json");

	const nested = await handler.resolve(new URL("agent://Parent/resolvedModel") as never);
	expect(nested.content).toBe("child capsule");
	expect(nested.contentType).toBe("text/markdown");
});

it("agent:// resolvedModel extraction fills from live session getActiveModelString", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "resolved-model-live.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(path.join(rootArtifactsDir, "LiveId.md"), JSON.stringify({ result: { ok: true } }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
		getActiveModelString: () => "openrouter/live:free",
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "LiveId",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		history: { resolvedModel: "openrouter/foo:free" },
	});

	const extracted = await new AgentProtocolHandler().resolve(new URL("agent://LiveId/resolvedModel") as never);
	expect(JSON.parse(extracted.content)).toBe("openrouter/live:free");
});

it("agent:// nested Child/resolvedModel does not invent a Child id from Parent history", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "resolved-model-no-child.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(path.join(rootArtifactsDir, "Parent.md"), JSON.stringify({ result: { ok: true } }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: null,
		status: "parked",
		history: { resolvedModel: "openrouter/foo:free" },
	});

	const extracted = await new AgentProtocolHandler().resolve(new URL("agent://Parent/Child/resolvedModel") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toBeNull();
});

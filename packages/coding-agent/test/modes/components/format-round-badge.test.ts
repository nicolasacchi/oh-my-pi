import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { formatRoundBadge } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub-renderer";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const ansiPattern = /\x1b\[[0-9;]*m/g;

describe("formatRoundBadge", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	it("renders round i/N when both fields exist", () => {
		const text = formatRoundBadge({ round: 2, of: 3 })?.replace(ansiPattern, "");
		expect(text).toContain("round 2/3");
	});

	it("renders round i without a slash when of is omitted", () => {
		const text = formatRoundBadge({ round: 1 })?.replace(ansiPattern, "");
		expect(text).toContain("round 1");
		expect(text).not.toContain("/");
	});

	it("returns undefined when round is missing or non-finite", () => {
		expect(formatRoundBadge({})).toBeUndefined();
		expect(formatRoundBadge({ of: 3 })).toBeUndefined();
		expect(formatRoundBadge({ round: Number.NaN })).toBeUndefined();
		expect(formatRoundBadge({ round: Number.POSITIVE_INFINITY })).toBeUndefined();
		expect(formatRoundBadge({ round: Number.NEGATIVE_INFINITY })).toBeUndefined();
	});

	it("returns undefined for non-objects and null", () => {
		expect(formatRoundBadge(null)).toBeUndefined();
		expect(formatRoundBadge("round 1")).toBeUndefined();
		expect(formatRoundBadge(1)).toBeUndefined();
		expect(formatRoundBadge(true)).toBeUndefined();
	});
});

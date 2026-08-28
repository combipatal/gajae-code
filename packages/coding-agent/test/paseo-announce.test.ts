import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	announceSessionToPaseo,
	classifyImportFailure,
	createDefaultPaseoAnnounceDependencies,
	isRetryableOutcome,
	type PaseoAnnounceDependencies,
	type PaseoAnnounceOutcome,
	type PaseoDaemonTarget,
	parseDaemonListen,
	resolveDaemonTarget,
	resolvePaseoHome,
	selectProviderKey,
	startPaseoAnnouncement,
} from "../src/setup/paseo/announce";

const SESSION_ID = "01a045e7-3d51-7387-a868-a8ba3eecd2d1";
const CWD = "/Users/probe/git/example";

/** The measured shape of a `gjc setup paseo` provider entry. */
function providerEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		extends: "acp",
		label: "Gajae Code",
		command: ["/usr/local/bin/gjc", "acp"],
		env: { GJC_ACP_PERMISSION_MODE: "prompt" },
		enabled: true,
		...overrides,
	};
}

function config(providers: Record<string, unknown>, daemonListen = "127.0.0.1:6767"): Record<string, unknown> {
	return { version: 1, daemon: { listen: daemonListen }, agents: { providers } };
}

interface Recorder {
	readonly imports: Array<{ providerKey: string; cwd: string; sessionId: string }>;
	readonly probes: PaseoDaemonTarget[];
}

function deps(
	overrides: Partial<PaseoAnnounceDependencies> & { readonly configValue?: unknown } = {},
): PaseoAnnounceDependencies & { readonly recorder: Recorder } {
	const recorder: Recorder = { imports: [], probes: [] };
	const configValue = "configValue" in overrides ? overrides.configValue : config({ gjc: providerEntry() });
	const base: PaseoAnnounceDependencies = {
		configJson: "/home/u/.paseo/config.json",
		paseoHome: "/home/u/.paseo",
		env: {},
		readJson: async file => (file.endsWith("config.json") ? configValue : undefined),
		resolveCli: () => "/opt/homebrew/bin/paseo",
		probeDaemon: async target => {
			recorder.probes.push(target);
			return true;
		},
		isSessionLive: async () => true,
		runImport: async input => {
			recorder.imports.push({ providerKey: input.providerKey, cwd: input.cwd, sessionId: input.sessionId });
			return { kind: "imported", providerKey: input.providerKey };
		},
	};
	const { configValue: _ignored, ...rest } = overrides;
	return { ...base, ...rest, recorder };
}

describe("selectProviderKey", () => {
	test("prefers the base provider over an mpreset provider", () => {
		expect(selectProviderKey(config({ "gjc-codex-eco": providerEntry(), gjc: providerEntry() }))).toBe("gjc");
	});

	test("falls back to the lowest-sorting enabled mpreset provider", () => {
		expect(selectProviderKey(config({ "gjc-plan": providerEntry(), "gjc-codex-eco": providerEntry() }))).toBe(
			"gjc-codex-eco",
		);
	});

	test("never selects a disabled entry", () => {
		expect(selectProviderKey(config({ gjc: providerEntry({ enabled: false }) }))).toBeUndefined();
		expect(
			selectProviderKey(config({ gjc: providerEntry({ enabled: false }), "gjc-codex-eco": providerEntry() })),
		).toBe("gjc-codex-eco");
	});

	test("ignores foreign providers and malformed configs", () => {
		expect(selectProviderKey(config({ codex: providerEntry(), claude: providerEntry() }))).toBeUndefined();
		expect(selectProviderKey({ agents: { providers: [] } })).toBeUndefined();
		expect(selectProviderKey(undefined)).toBeUndefined();
	});

	test("does not treat a same-prefix foreign key as a preset provider", () => {
		expect(selectProviderKey(config({ gjcx: providerEntry() }))).toBeUndefined();
	});
});

describe("parseDaemonListen", () => {
	test("parses every listener spelling Paseo accepts", () => {
		expect(parseDaemonListen("127.0.0.1:6767")).toEqual({ kind: "tcp", host: "127.0.0.1", port: 6767 });
		expect(parseDaemonListen("tcp://10.0.0.2:7000?ssl=true")).toEqual({ kind: "tcp", host: "10.0.0.2", port: 7000 });
		expect(parseDaemonListen("6767")).toEqual({ kind: "tcp", host: "127.0.0.1", port: 6767 });
		expect(parseDaemonListen("[::1]:6767")).toEqual({ kind: "tcp", host: "::1", port: 6767 });
		expect(parseDaemonListen("unix:///tmp/paseo.sock")).toEqual({ kind: "ipc", socketPath: "/tmp/paseo.sock" });
		expect(parseDaemonListen("/tmp/paseo.sock")).toEqual({ kind: "ipc", socketPath: "/tmp/paseo.sock" });
		expect(parseDaemonListen("pipe://\\\\.\\pipe\\paseo")).toEqual({ kind: "ipc", socketPath: "\\\\.\\pipe\\paseo" });
	});

	test("rejects values that carry no usable endpoint", () => {
		expect(parseDaemonListen("")).toBeUndefined();
		expect(parseDaemonListen("   ")).toBeUndefined();
		expect(parseDaemonListen("localhost")).toBeUndefined();
		expect(parseDaemonListen("host:0")).toBeUndefined();
		expect(parseDaemonListen("host:70000")).toBeUndefined();
		expect(parseDaemonListen("host:notaport")).toBeUndefined();
		expect(parseDaemonListen(":6767")).toBeUndefined();
	});
});

describe("resolveDaemonTarget", () => {
	const base = { env: {}, paseoHome: "/home/u/.paseo", readJson: async () => undefined };

	test("prefers the environment override over every file", async () => {
		expect(
			await resolveDaemonTarget(config({}, "127.0.0.1:6767"), {
				...base,
				env: { PASEO_HOST: "10.1.1.1:9999" },
				readJson: async () => ({ listen: "/tmp/from-pid.sock" }),
			}),
		).toEqual({ kind: "tcp", host: "10.1.1.1", port: 9999 });
	});

	test("prefers the running daemon's pid file over the configured listener", async () => {
		expect(
			await resolveDaemonTarget(config({}, "127.0.0.1:6767"), {
				...base,
				readJson: async () => ({ sockPath: "/tmp/from-pid.sock" }),
			}),
		).toEqual({ kind: "ipc", socketPath: "/tmp/from-pid.sock" });
	});

	test("falls back to the configured listener, then to Paseo's default", async () => {
		expect(await resolveDaemonTarget(config({}, "127.0.0.1:7777"), base)).toEqual({
			kind: "tcp",
			host: "127.0.0.1",
			port: 7777,
		});
		expect(await resolveDaemonTarget({ version: 1 }, base)).toEqual({ kind: "tcp", host: "127.0.0.1", port: 6767 });
	});

	test("ignores an unparseable listener instead of failing the announcement", async () => {
		expect(await resolveDaemonTarget(config({}, "not-an-endpoint"), base)).toEqual({
			kind: "tcp",
			host: "127.0.0.1",
			port: 6767,
		});
	});
});

describe("resolvePaseoHome", () => {
	test("honors PASEO_HOME and otherwise uses the home directory", () => {
		expect(resolvePaseoHome({ PASEO_HOME: "/srv/paseo" }, "/home/u")).toBe("/srv/paseo");
		expect(resolvePaseoHome({}, "/home/u")).toBe(path.join("/home/u", ".paseo"));
		expect(resolvePaseoHome({ PASEO_HOME: "   " }, "/home/u")).toBe(path.join("/home/u", ".paseo"));
	});
});

describe("announceSessionToPaseo", () => {
	test("imports a live session under the selected provider", async () => {
		const dependencies = deps();
		const outcome = await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies);
		expect(outcome).toEqual({ kind: "imported", providerKey: "gjc" });
		expect(dependencies.recorder.imports).toEqual([{ providerKey: "gjc", cwd: CWD, sessionId: SESSION_ID }]);
	});

	test("skips when Paseo is not installed at all", async () => {
		const dependencies = deps({ configValue: undefined });
		expect(await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies)).toEqual({
			kind: "skipped",
			reason: "no-paseo-config",
		});
		expect(dependencies.recorder.probes).toHaveLength(0);
	});

	test("skips when no GJC provider is registered", async () => {
		const dependencies = deps({ configValue: config({ codex: providerEntry() }) });
		expect(await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies)).toEqual({
			kind: "skipped",
			reason: "no-provider",
		});
		expect(dependencies.recorder.probes).toHaveLength(0);
	});

	test("skips when the paseo CLI is absent", async () => {
		const dependencies = deps({ resolveCli: () => undefined });
		expect(await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies)).toEqual({
			kind: "skipped",
			reason: "cli-missing",
		});
		expect(dependencies.recorder.probes).toHaveLength(0);
	});

	test("never spawns the CLI when the daemon socket is unreachable", async () => {
		// The Paseo CLI blocks indefinitely without a daemon, so the probe is the
		// only thing standing between an interactive launch and a wedged child.
		const dependencies = deps({ probeDaemon: async () => false });
		expect(await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies)).toEqual({
			kind: "skipped",
			reason: "daemon-unreachable",
		});
		expect(dependencies.recorder.imports).toHaveLength(0);
	});

	test("never imports a session the broker does not report as live", async () => {
		// ACP session/load resumes a second host for a non-live id, so importing
		// before registration lands would fork the running session.
		const dependencies = deps({ isSessionLive: async () => false });
		expect(await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies)).toEqual({
			kind: "skipped",
			reason: "session-not-live",
		});
		expect(dependencies.recorder.imports).toHaveLength(0);
	});

	test("probes the endpoint the daemon pid file reports", async () => {
		const dependencies = deps({
			readJson: async file =>
				file.endsWith("config.json")
					? config({ gjc: providerEntry() }, "127.0.0.1:6767")
					: { listen: "/tmp/live.sock" },
		});
		await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies);
		expect(dependencies.recorder.probes).toEqual([{ kind: "ipc", socketPath: "/tmp/live.sock" }]);
	});

	test("propagates a failed import verbatim", async () => {
		const dependencies = deps({ runImport: async () => ({ kind: "failed", detail: "daemon refused" }) });
		expect(await announceSessionToPaseo({ sessionId: SESSION_ID, cwd: CWD }, dependencies)).toEqual({
			kind: "failed",
			detail: "daemon refused",
		});
	});
});

describe("classifyImportFailure", () => {
	test("reads Paseo's duplicate-import refusal as success", () => {
		expect(classifyImportFailure("gjc", `Provider session is already imported: ${SESSION_ID}`)).toEqual({
			kind: "already-imported",
			providerKey: "gjc",
		});
	});

	test("keeps a genuine failure and bounds its detail", () => {
		expect(classifyImportFailure("gjc", "DAEMON_NOT_RUNNING")).toEqual({
			kind: "failed",
			detail: "DAEMON_NOT_RUNNING",
		});
		const outcome = classifyImportFailure("gjc", "x".repeat(2000));
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" && outcome.detail.length).toBe(500);
	});
});

describe("isRetryableOutcome", () => {
	test("retries only the two states Paseo can still grow out of", () => {
		const retryable: PaseoAnnounceOutcome[] = [
			{ kind: "skipped", reason: "daemon-unreachable" },
			{ kind: "skipped", reason: "session-not-live" },
		];
		const terminal: PaseoAnnounceOutcome[] = [
			{ kind: "skipped", reason: "no-paseo-config" },
			{ kind: "skipped", reason: "no-provider" },
			{ kind: "skipped", reason: "cli-missing" },
			{ kind: "imported", providerKey: "gjc" },
			{ kind: "already-imported", providerKey: "gjc" },
			{ kind: "failed", detail: "boom" },
		];
		expect(retryable.every(isRetryableOutcome)).toBe(true);
		expect(terminal.some(isRetryableOutcome)).toBe(false);
	});
});

describe("default dependencies", () => {
	const temporaryRoots: string[] = [];

	afterAll(async () => {
		await Promise.all(temporaryRoots.map(root => fs.rm(root, { recursive: true, force: true })));
	});

	async function fakeCli(body: string): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-paseo-cli-"));
		temporaryRoots.push(root);
		const cli = path.join(root, "paseo");
		await Bun.write(cli, `#!/bin/sh\n${body}\n`);
		await fs.chmod(cli, 0o700);
		return cli;
	}

	const importInput = (cli: string) => ({ cli, providerKey: "gjc", cwd: "/tmp/repo", sessionId: SESSION_ID });

	test("a socket probe answers false without blocking when nothing listens", async () => {
		const dependencies = createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {});
		const started = Date.now();
		expect(
			await dependencies.probeDaemon({ kind: "ipc", socketPath: path.join(os.tmpdir(), "gjc-absent.sock") }),
		).toBe(false);
		expect(await dependencies.probeDaemon({ kind: "tcp", host: "127.0.0.1", port: 1 })).toBe(false);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("a socket probe answers true for a real listener", async () => {
		const dependencies = createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {});
		const server = net.createServer(() => {});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			expect(await dependencies.probeDaemon({ kind: "tcp", host: "127.0.0.1", port })).toBe(true);
		} finally {
			server.close();
		}
	});

	test("resolves the CLI through the injected environment, not the ambient PATH", async () => {
		// The env is a dependency of this module; a lookup that ignored it would
		// resolve a different executable than every other step reasons about.
		const cli = await fakeCli("exit 0");
		const binDir = path.dirname(cli);
		expect(createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", { PATH: binDir }).resolveCli()).toBe(cli);
		expect(
			createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {
				PATH: path.join(os.tmpdir(), "gjc-empty-path-dir"),
			}).resolveCli(),
		).toBeUndefined();
	});

	test("a successful import reports the provider it imported under", async () => {
		const dependencies = createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {});
		const cli = await fakeCli('printf "%s\\n" "$*" > "$(dirname "$0")/argv"; exit 0');
		expect(await dependencies.runImport(importInput(cli))).toEqual({ kind: "imported", providerKey: "gjc" });
		expect((await Bun.file(path.join(path.dirname(cli), "argv")).text()).trim()).toBe(
			`import --provider gjc --cwd /tmp/repo ${SESSION_ID}`,
		);
	});

	test("Paseo's duplicate-import refusal on stderr is read as success", async () => {
		const dependencies = createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {});
		const cli = await fakeCli(
			`echo "Failed to import agent: Provider session is already imported: ${SESSION_ID}" >&2\nexit 1`,
		);
		expect(await dependencies.runImport(importInput(cli))).toEqual({ kind: "already-imported", providerKey: "gjc" });
	});

	test("a genuine CLI failure surfaces its stderr", async () => {
		const dependencies = createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {});
		const cli = await fakeCli('echo "Cannot connect to daemon at localhost:6767" >&2\nexit 1');
		const outcome = await dependencies.runImport(importInput(cli));
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" && outcome.detail).toContain("Cannot connect to daemon");
	});

	test("an unlaunchable CLI fails instead of throwing", async () => {
		const dependencies = createDefaultPaseoAnnounceDependencies("/tmp/agent-dir", {});
		const outcome = await dependencies.runImport(importInput(path.join(os.tmpdir(), "gjc-absent-paseo")));
		expect(outcome.kind).toBe("failed");
	});
});

describe("startPaseoAnnouncement", () => {
	test("reports a terminal outcome exactly once", async () => {
		const outcomes: PaseoAnnounceOutcome[] = [];
		const handle = startPaseoAnnouncement(
			{ sessionId: SESSION_ID, cwd: CWD, onOutcome: outcome => outcomes.push(outcome) },
			deps(),
		);
		await Bun.sleep(20);
		handle.cancel();
		expect(outcomes).toEqual([{ kind: "imported", providerKey: "gjc" }]);
	});

	test("does not report a retryable outcome, and stays silent after cancel", async () => {
		const outcomes: PaseoAnnounceOutcome[] = [];
		const handle = startPaseoAnnouncement(
			{ sessionId: SESSION_ID, cwd: CWD, onOutcome: outcome => outcomes.push(outcome) },
			deps({ probeDaemon: async () => false }),
		);
		await Bun.sleep(20);
		handle.cancel();
		await Bun.sleep(20);
		expect(outcomes).toEqual([]);
	});

	test("converts a thrown dependency into a failed outcome instead of an unhandled rejection", async () => {
		const outcomes: PaseoAnnounceOutcome[] = [];
		const handle = startPaseoAnnouncement(
			{ sessionId: SESSION_ID, cwd: CWD, onOutcome: outcome => outcomes.push(outcome) },
			deps({
				isSessionLive: async () => {
					throw new Error("broker is unavailable");
				},
			}),
		);
		await Bun.sleep(20);
		handle.cancel();
		expect(outcomes).toEqual([{ kind: "failed", detail: "broker is unavailable" }]);
	});
});

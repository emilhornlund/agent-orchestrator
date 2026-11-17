import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CommandRunner } from "../src/process/command-runner.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { createPublicationFixture } from "./support/initial-publication-fixture.js";
import { runRepositorySetup } from "../src/process/run-setup.js";
import { runTaskSessionValidation } from "../src/task-session/run-task-session-validation.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";

it("lets validation and isolated agent descendants reach services through configured task settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-service-connectivity-"));
  let connections = 0;
  const service = net.createServer((socket) => {
    connections += 1;
    socket.end("service-ok");
  });
  try {
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address() as net.AddressInfo;
    vi.stubEnv("PROJECT_TEST_SERVICE_HOST", "127.0.0.1");
    vi.stubEnv("PROJECT_TEST_SERVICE_PORT", String(address.port));
    vi.stubEnv("TRELLO_TOKEN", "must-not-reach-the-task");
    const f = createPublicationFixture(root);
    f.project.taskEnvironment = {
      TEST_SERVICE_HOST: "PROJECT_TEST_SERVICE_HOST",
      TEST_SERVICE_PORT: "PROJECT_TEST_SERVICE_PORT",
    };
    f.project.repository.validationCommand = `"${process.execPath}" service-probe.cjs`;
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    const probe = `
if (process.env.TRELLO_TOKEN || process.env.PROJECT_TEST_SERVICE_HOST || process.env.PROJECT_TEST_SERVICE_PORT) process.exit(41);
const socket = require('node:net').connect({host: process.env.TEST_SERVICE_HOST, port: Number(process.env.TEST_SERVICE_PORT)});
socket.setTimeout(2000, () => socket.destroy(new Error('service timeout')));
socket.on('error', error => { console.error(error); process.exitCode = 42; });
socket.on('data', data => console.log(data.toString()));
`;
    // The agent launches a real descendant, as it would when running project tests.
    fs.writeFileSync(path.join(f.worktreePath, "service-probe.cjs"), probe);
    fs.writeFileSync(
      path.join(bin, "opencode"),
      `#!${process.execPath}\nconst {spawnSync} = require('node:child_process');
const result = spawnSync(process.execPath, ['service-probe.cjs'], {encoding: 'utf8'});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 43);\n`,
      { mode: 0o700 },
    );
    const environment = {
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
    };
    const commands = new CommandRunner();
    const setup = await runRepositorySetup(commands, {
      cwd: f.worktreePath,
      command: f.project.repository.validationCommand,
      taskEnvironment: f.project.taskEnvironment,
      timeoutMilliseconds: 10_000,
      sessionLogPath: path.join(root, "setup.log"),
      sessionLabel: "Service-aware setup",
    });
    expect(setup.exitCode).toBe(0);
    const validation = await f.authority.run(() =>
      runTaskSessionValidation({
        project: f.project,
        cardId: "card",
        expectedBranch: "agent/card",
        operationKey: "operation",
        worktreePath: f.worktreePath,
        taskRecordStore: new TaskExecutionStore(f.project.contextRoot, f.project),
        git: f.git,
        commands,
        signal: new AbortController().signal,
        timeoutMilliseconds: 10_000,
      }),
    );
    expect(validation.status, validation.diagnostic).toBe("passed");
    expect(validation.diagnostic).toContain("service-ok");
    const agent = await f.authority.run(() =>
      new OpenCodeClient().run({
        cwd: f.worktreePath,
        model: "openai/test",
        prompt: "check task service connectivity",
        environment,
        taskEnvironment: f.project.taskEnvironment,
        timeoutMilliseconds: 10_000,
        signal: new AbortController().signal,
      }),
    );
    expect(agent.exitCode, agent.errorOutput).toBe(0);
    expect(agent.output).toContain("service-ok");
    expect(connections).toBe(3);
    const unrelatedProject = await commands.run({
      cwd: f.worktreePath,
      command: `"${process.execPath}" -e 'if(process.env.TEST_SERVICE_HOST || process.env.PROJECT_TEST_SERVICE_HOST)process.exit(44)'`,
      timeoutMilliseconds: 10_000,
    });
    expect(unrelatedProject.exitCode).toBe(0);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      service.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps concurrent projects' identically named settings separate and resolves updated sources on later dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-task-environments-"));
  try {
    vi.stubEnv("PROJECT_A_ENDPOINT", "project-a-service");
    vi.stubEnv("PROJECT_B_ENDPOINT", "project-b-service");
    fs.writeFileSync(
      path.join(root, "opencode"),
      `#!${process.execPath}\nconsole.log(process.env.APP_ENDPOINT);\n`,
      { mode: 0o700 },
    );
    const commands = new CommandRunner();
    const opencode = new OpenCodeClient();
    const dispatch = async (source: string) => {
      const taskEnvironment = { APP_ENDPOINT: source };
      return Promise.all([
        commands.run({
          cwd: root,
          command: `"${process.execPath}" -e 'console.log(process.env.APP_ENDPOINT)'`,
          taskEnvironment,
          captureOutput: true,
          suppressOutput: true,
        }),
        opencode.run({
          cwd: root,
          model: "openai/test",
          prompt: "inspect",
          signal: new AbortController().signal,
          timeoutMilliseconds: 10_000,
          environment: { PATH: `${root}:${process.env.PATH}`, HOME: root },
          taskEnvironment,
        }),
      ]);
    };
    const [a, b] = await Promise.all([
      dispatch("PROJECT_A_ENDPOINT"),
      dispatch("PROJECT_B_ENDPOINT"),
    ]);
    for (const result of a) expect(result.output?.trim()).toBe("project-a-service");
    for (const result of b) expect(result.output?.trim()).toBe("project-b-service");
    vi.stubEnv("PROJECT_A_ENDPOINT", "updated-project-a-service");
    for (const result of await dispatch("PROJECT_A_ENDPOINT"))
      expect(result.output?.trim()).toBe("updated-project-a-service");
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("redacts explicitly mapped task credentials and credential-bearing URLs from child output and persisted diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-environment-redaction-"));
  try {
    const password = "private-task-password";
    const url = "mongodb://task-user:task-pass@database:27017/test";
    vi.stubEnv("PROJECT_LOGIN", password);
    vi.stubEnv("PROJECT_CONNECTION", url);
    const taskEnvironment = { APP_PASSWORD: "PROJECT_LOGIN", DATABASE_URL: "PROJECT_CONNECTION" };
    const script =
      "console.log('task-values:', process.env.APP_PASSWORD, process.env.DATABASE_URL)";
    fs.writeFileSync(path.join(root, "opencode"), `#!${process.execPath}\n${script};\n`, {
      mode: 0o700,
    });
    const sessionLogPath = path.join(root, "session.log");
    const results = await Promise.all([
      new CommandRunner().run({
        cwd: root,
        command: `"${process.execPath}" -e ${JSON.stringify(script)}`,
        taskEnvironment,
        captureOutput: true,
        suppressOutput: true,
        sessionLogPath,
        artifactDirectory: path.join(root, "command-evidence"),
      }),
      new OpenCodeClient().run({
        cwd: root,
        model: "openai/test",
        prompt: "inspect",
        signal: new AbortController().signal,
        timeoutMilliseconds: 10_000,
        environment: { PATH: `${root}:${process.env.PATH}`, HOME: root },
        taskEnvironment,
        sessionLogPath: path.join(root, "agent-session.log"),
      }),
    ]);
    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("[REDACTED]");
      expect(result.output).not.toContain(password);
      expect(result.output).not.toContain(url);
    }
    for (const log of [sessionLogPath, path.join(root, "agent-session.log")]) {
      expect(fs.readFileSync(log, "utf8")).not.toContain(password);
      expect(fs.readFileSync(log, "utf8")).not.toContain(url);
    }
    const [execution] = fs.readdirSync(path.join(root, "command-evidence"));
    const stdout = fs.readFileSync(
      path.join(root, "command-evidence", execution!, "stdout.txt"),
      "utf8",
    );
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain(password);
    expect(stdout).not.toContain(url);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

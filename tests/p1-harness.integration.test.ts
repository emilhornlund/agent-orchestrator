import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRealGitFixture,
  P1Observer,
  P1ServiceHarness,
  runActualProcess,
} from "./support/p1-stateful-harness.js";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("P1 stateful offline verification harness", () => {
  it("reads service state independently and discovers a PR accepted before its response was lost", async () => {
    const services = new P1ServiceHarness();
    services.seedCard("card-1", { list: "Working" });
    const lostResponse = await services.createPullRequest(
      "head-sha",
      "accept-without-response",
    );
    expect(lostResponse).toBeUndefined();
    const restarted = new P1ServiceHarness();
    restarted.restoreState(services.exportState());
    const observer = new P1Observer(restarted);
    expect(observer.snapshot().pullRequests).toEqual([
      {
        id: "pr-1",
        head: "head-sha",
        state: "open",
        draft: false,
        approvals: 0,
      },
    ]);
    // Reconcile from the independently visible resource, not the caller result.
    const existing = restarted
      .readPullRequests()
      .find(([, pr]) => pr.head === "head-sha");
    expect(existing?.[0]).toBe("pr-1");
    restarted.clock.advance(250);
    expect(restarted.clock.now()).toBe(250);
    expect(restarted.ledger.map(({ kind }) => kind)).toEqual([
      "request",
      "acceptance",
      "read",
    ]);
    expect(() => observer.assertNoForbiddenOrDuplicateEffects()).not.toThrow();
    const exposedResources = restarted.resources;
    exposedResources.pullRequests.clear();
    const exposedHistory =
      restarted.ledger as import("./support/p1-stateful-harness.js").LedgerEvent[];
    exposedHistory.splice(0);
    expect(new P1Observer(restarted).snapshot().pullRequests).toHaveLength(1);
    expect(restarted.ledger).toHaveLength(3);
    expect(() => restarted.readPullRequests("reject")).toThrow(/rejected/);
    expect(() =>
      restarted.readPullRequests("timeout-before-acceptance"),
    ).toThrow(/timeout/);
  });

  it("supports deterministic success, rejection, pre-acceptance timeout, delay, and missing-result controls", async () => {
    const services = new P1ServiceHarness();
    expect(await services.createPullRequest("success")).toBe("pr-1");
    await expect(
      services.createPullRequest("rejected", "reject"),
    ).rejects.toMatchObject({ kind: "rejected" });
    await expect(
      services.createPullRequest("timed-out", "timeout-before-acceptance"),
    ).rejects.toMatchObject({ kind: "timeout" });
    services.clock.advance(50);
    expect(await services.createPullRequest("delayed", "delay")).toBe("pr-4");
    expect(services.clock.now()).toBe(550); // delay advances virtual time, never wall-clock sleep.
    await expect(
      services.createPullRequest("missing", "missing"),
    ).rejects.toMatchObject({ kind: "missing" });
    expect(
      services.ledger.filter((event) => event.kind === "acceptance"),
    ).toHaveLength(2);
    expect(
      services.ledger.filter((event) => event.kind === "request"),
    ).toHaveLength(5);
  });

  it("allows distinct PR attempts and rejects restore into a nonzero-clock harness", async () => {
    const source = new P1ServiceHarness();
    await source.createPullRequest("same-head", "success", {
      repository: "owner/repo",
      base: "main",
      attemptId: "a1",
      correlationId: "c1",
    });
    await source.createPullRequest("same-head", "success", {
      repository: "owner/repo",
      base: "main",
      attemptId: "a2",
      correlationId: "c2",
    });
    expect(() =>
      new P1Observer(source).assertNoForbiddenOrDuplicateEffects(),
    ).not.toThrow();
    const target = new P1ServiceHarness();
    target.clock.advance(1);
    expect(() => target.restoreState(source.exportState())).toThrow(
      /fresh service harness/,
    );
  });

  it("reserves distinct accepted PR resources for concurrent identical operation identities", async () => {
    const services = new P1ServiceHarness();
    services.barriers.arm("before-acceptance");
    const identity = {
      repository: "owner/repo",
      base: "main",
      attemptId: "same-attempt",
      correlationId: "same-correlation",
    };
    const first = services.createPullRequest("same-head", "success", identity);
    const second = services.createPullRequest("same-head", "success", identity);
    expect(
      services.ledger
        .filter((event) => event.kind === "request")
        .map(({ resourceId }) => resourceId),
    ).toEqual(["pr-1", "pr-2"]);
    services.barriers.release("before-acceptance");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "pr-1",
      "pr-2",
    ]);
    expect(services.resources.pullRequests.size).toBe(2);
    expect(
      services.ledger
        .filter((event) => event.kind === "acceptance")
        .map(({ resourceId }) => resourceId)
        .sort(),
    ).toEqual(["pr-1", "pr-2"]);
    expect(() =>
      new P1Observer(services).assertNoForbiddenOrDuplicateEffects(),
    ).toThrow(/Duplicate PR resources/);
  });

  it("pauses at the accepted-before-response boundary and resumes only when explicitly released", async () => {
    const services = new P1ServiceHarness();
    services.barriers.arm("before-response");
    let returned = false;
    const create = services.createPullRequest("barrier-head").then((id) => {
      returned = true;
      return id;
    });
    await services.barriers.waitUntil("before-response");
    expect(returned).toBe(false);
    expect(new P1Observer(services).snapshot().pullRequests).toHaveLength(1);
    expect(services.ledger.map((event) => event.kind)).toEqual([
      "request",
      "acceptance",
    ]);
    services.barriers.release("before-response");
    expect(await create).toBe("pr-1");
    expect(services.ledger.at(-1)?.kind).toBe("response");
  });

  it("covers every acceptance barrier and observes late acceptance after a failed negative read", async () => {
    for (const position of [
      "before-acceptance",
      "after-acceptance",
      "before-response",
    ] as const) {
      const services = new P1ServiceHarness();
      services.barriers.arm(position);
      const create = services.createPullRequest(`head-${position}`);
      await services.barriers.waitUntil(position);
      if (position === "before-acceptance")
        expect(services.resources.pullRequests.size).toBe(0);
      else expect(services.resources.pullRequests.size).toBe(1);
      services.barriers.release(position);
      await create;
    }
    const services = new P1ServiceHarness();
    services.barriers.arm("before-acceptance");
    const create = services.createPullRequest("late-head");
    await services.barriers.waitUntil("before-acceptance");
    expect(() => services.readPullRequests("reject")).toThrow(/rejected/);
    expect(services.resources.pullRequests.size).toBe(0);
    services.barriers.release("before-acceptance");
    await create;
    expect(new P1Observer(services).snapshot().pullRequests).toHaveLength(1);
  });

  it("cleans up concurrent, cancelled, timed out, and re-armed barrier generations", async () => {
    const barriers = new P1ServiceHarness().barriers;
    barriers.arm("shared");
    expect(() => barriers.arm("shared")).toThrow(/already armed/);
    const one = barriers.waitUntil("shared");
    const two = barriers.waitUntil("shared");
    const stopping = barriers.stop("shared");
    await barriers.waitUntil("shared");
    await Promise.all([one, two]);
    expect(() => barriers.arm("shared")).toThrow(/already armed/);
    barriers.release("shared");
    await stopping;
    const stoppingAgain = barriers.stop("shared");
    await barriers.waitUntil("shared");
    barriers.release("shared");
    await stoppingAgain;
    barriers.arm("shared");
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      barriers.waitUntil("shared", 100, controller.signal),
    ).rejects.toThrow(/already cancelled/);
    await expect(barriers.waitUntil("shared", 5)).rejects.toThrow(/timed out/);
    const pendingController = new AbortController();
    const cancelled = barriers.waitUntil(
      "shared",
      1000,
      pendingController.signal,
    );
    pendingController.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(() => barriers.arm("shared")).toThrow(/already armed/);
    const cancellationStop = barriers.stop("shared");
    await barriers.waitUntil("shared");
    barriers.release("shared");
    await cancellationStop;
    barriers.arm("shared");
    const next = barriers.waitUntil("shared");
    const finalStop = barriers.stop("shared");
    await barriers.waitUntil("shared");
    await next;
    barriers.release("shared");
    await finalStop;
  });

  it("detects duplicated PR/comment effects and transient forbidden actions in the whole ledger", async () => {
    const services = new P1ServiceHarness();
    services.seedCard("card-1", { list: "Human Review" });
    await services.createPullRequest("same-head");
    await services.createPullRequest("same-head");
    services.addComment("card-1", "published");
    services.addComment("card-1", "published");
    expect(services.resources.pullRequests.size).toBe(2); // Each accepted create is an independently visible resource.
    expect(services.resources.cards.get("card-1")?.comments).toHaveLength(2);
    expect(() =>
      new P1Observer(services).assertNoForbiddenOrDuplicateEffects(),
    ).toThrow(/Duplicate PR resources/);
    const duplicatePrs = new P1ServiceHarness();
    await duplicatePrs.createPullRequest("same-head");
    await duplicatePrs.createPullRequest("same-head");
    expect(() =>
      new P1Observer(duplicatePrs).assertNoForbiddenOrDuplicateEffects(),
    ).toThrow(/Duplicate PR resources/);
    const humanMerge = new P1ServiceHarness();
    humanMerge.dispatch("merge-pr", "github", "approved human merge", "human");
    expect(() =>
      new P1Observer(humanMerge).assertNoForbiddenOrDuplicateEffects(),
    ).not.toThrow();
    services.dispatch(
      "merge-pr",
      "github",
      "orchestrator merge attempt",
      "orchestrator",
    );
    const observer = new P1Observer(services);
    expect(() => observer.assertNoForbiddenOrDuplicateEffects()).toThrow(
      /Forbidden ledger/,
    );

    const duplicateComments = new P1ServiceHarness();
    duplicateComments.seedCard("card-2", { list: "Human Review" });
    duplicateComments.addComment("card-2", "same effect");
    duplicateComments.addComment("card-2", "same effect");
    expect(() =>
      new P1Observer(duplicateComments).assertNoForbiddenOrDuplicateEffects(),
    ).toThrow(/Duplicate accepted comment/);

    const forced = new P1ServiceHarness();
    forced.dispatch(
      "force-push",
      "git",
      "negative control: transient attempt then final refs restored",
    );
    expect(() =>
      new P1Observer(forced).assertNoForbiddenOrDuplicateEffects(),
    ).toThrow(/force-push/);
    for (const argv of [
      ["push", "--force"],
      ["push", "--force-with-lease=main"],
      ["push", "+refs/heads/main"],
    ]) {
      const unsafeArgv = new P1ServiceHarness();
      unsafeArgv.recordGitArgv(argv);
      expect(() =>
        new P1Observer(unsafeArgv).assertNoForbiddenOrDuplicateEffects(),
      ).toThrow(/Forbidden/);
    }
    const transient = new P1ServiceHarness();
    transient.dispatch(
      "git-reset",
      "git",
      "unsafe transient then ref restored",
    );
    expect(() =>
      new P1Observer(transient).assertNoForbiddenOrDuplicateEffects(),
    ).toThrow(/Forbidden/);
  });

  it("uses real Git source/worktree/bare remote and executes an actual child check command", () => {
    const fixture = createRealGitFixture();
    roots.push(fixture.root);
    const before = fixture.git("rev-parse", "HEAD");
    expect(fixture.gitArgv.some((args) => args.includes("ls-remote"))).toBe(
      false,
    );
    fs.writeFileSync(
      path.join(fixture.worktree, "fixture.txt"),
      "implemented\n",
    );
    const check = runActualProcess(
      process.execPath,
      ["-e", "process.stdout.write('check-ran')"],
      fixture.worktree,
    );
    expect(check.status).toBe(0);
    expect(check.stdout).toBe("check-ran");
    expect(fixture.git("-C", fixture.worktree, "status", "--short")).toContain(
      "fixture.txt",
    );
    expect(fixture.git("rev-parse", "HEAD")).toBe(before);
    expect(fixture.git("ls-remote", "origin", "refs/heads/main")).toContain(
      before,
    );
    const gitTrace = new P1ServiceHarness();
    for (const argv of fixture.gitArgv) gitTrace.recordGitArgv(argv);
    expect(
      gitTrace.ledger.filter((event) => event.service === "git" && event.argv)
        .length,
    ).toBeGreaterThan(0);
    expect(() =>
      new P1Observer(gitTrace).assertNoForbiddenOrDuplicateEffects(),
    ).not.toThrow();
    expect(
      runActualProcess("/missing/p1-executable", [], fixture.worktree).status,
    ).toBeNull();
    expect(
      runActualProcess(
        process.execPath,
        ["-e", "process.exit(7)"],
        fixture.worktree,
      ).status,
    ).toBe(7);
    const timedOut = runActualProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      fixture.worktree,
      50,
    );
    expect(timedOut.status).toBeNull();
  });

  it("records process termination and resumes from an independently durable checkpoint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-process-"));
    roots.push(root);
    const checkpoint = path.join(root, "accepted.json");
    const source = `require('fs').writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify({pr:'pr-real',head:'sha-real'})); setInterval(()=>{},1000)`;
    const child = spawn(process.execPath, ["-e", source], {
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "" },
    });
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          if (timer) clearTimeout(timer);
          if (poll) clearInterval(poll);
          child.removeListener("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onError = (error: Error) => finish(error);
        timer = setTimeout(
          () => finish(new Error("child checkpoint timeout")),
          5000,
        );
        child.once("error", onError);
        poll = setInterval(() => {
          if (child.exitCode !== null) {
            finish(new Error("checkpoint child exited before checkpoint"));
          }
          if (fs.existsSync(checkpoint)) {
            finish();
          }
        }, 10);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const reapTimer = setTimeout(resolve, 1000);
          child.once("close", () => {
            clearTimeout(reapTimer);
            resolve();
          });
        });
      }
    }
    const restartedState = JSON.parse(fs.readFileSync(checkpoint, "utf8")) as {
      pr: string;
      head: string;
    };
    expect(restartedState).toEqual({ pr: "pr-real", head: "sha-real" });
  });
});

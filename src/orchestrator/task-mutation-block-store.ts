import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";

const blockerSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostic: z.string().min(1),
});

const stateSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: z.string().min(1),
    blockers: z.array(blockerSchema).max(10_000),
  })
  .superRefine((state, context) => {
    const keys = new Set<string>();
    state.blockers.forEach((blocker, index) => {
      if (keys.has(blocker.key))
        context.addIssue({
          code: "custom",
          path: ["blockers", index, "key"],
          message: "Blocker scopes must be unique",
        });
      keys.add(blocker.key);
    });
  });
export function parseTaskMutationBlock(
  value: unknown,
): z.infer<typeof stateSchema> {
  const current = stateSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyStateSchema.parse(value);
  return {
    version: 1,
    projectId: legacy.projectId,
    blockers: [
      {
        key: createHash("sha256")
          .update(`legacy:${legacy.identity}`)
          .digest("hex"),
        identity: legacy.identity,
        diagnostic: legacy.diagnostic,
      },
    ],
  };
}

const legacyStateSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostic: z.string().min(1),
});

function ensureDirectory(directory: string): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const component of path
    .relative(parsed.root, directory)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Unsafe task mutation block directory: ${current}`);
  }
}

/** Durable, independently keyed suppression for mutation-queue blockers. */
export class TaskMutationBlockStore {
  private readonly filePath: string;
  private readonly authority: ProjectRunAuthority | undefined;

  constructor(
    contextRoot: string,
    private readonly projectId: string,
    authority?: ProjectRunAuthority,
  ) {
    if (!path.isAbsolute(contextRoot))
      throw new Error("Task mutation block root must be absolute");
    if (
      projectId.trim() !== projectId ||
      projectId.length === 0 ||
      projectId.includes("/") ||
      projectId.includes("\\") ||
      projectId === "." ||
      projectId === ".."
    )
      throw new Error("Invalid project ID for task mutation block state");
    this.filePath = path.join(
      path.resolve(contextRoot),
      "task-mutation-queues",
      `${projectId}.block.json`,
    );
    this.authority = authority ?? ProjectRunAuthority.current(projectId);
    if (authority && authority.projectId !== projectId)
      throw new Error("Task mutation block authority project mismatch");
  }

  report(
    scopeInput: string,
    identityInput: string,
    diagnostic: string,
  ): boolean {
    const key = this.hash(scopeInput);
    const identity = this.hash(identityInput);
    if (this.authority !== undefined)
      return this.authority.mutate(
        ProjectRunAuthority.mutationBlocksKey(this.projectId),
        { version: 1, projectId: this.projectId, blockers: [] },
        (value) => {
          const previous = stateSchema.parse(parseTaskMutationBlock(value));
          const current = previous.blockers.find(
            (blocker) => blocker.key === key,
          );
          if (current?.identity === identity)
            return { value: previous, result: false };
          const state = stateSchema.parse({
            version: 1,
            projectId: this.projectId,
            blockers: [
              ...previous.blockers.filter((blocker) => blocker.key !== key),
              { key, identity, diagnostic },
            ],
          });
          return { value: state, result: true };
        },
        stateSchema.parse,
      );
    const previous = this.read();
    const current = previous.blockers.find((blocker) => blocker.key === key);
    if (current?.identity === identity) return false;
    const directory = path.dirname(this.filePath);
    ensureDirectory(directory);
    const temporary = `${this.filePath}.${process.pid}.${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex")}.tmp`;
    const state = stateSchema.parse({
      version: 1,
      projectId: this.projectId,
      blockers: [
        ...previous.blockers.filter((blocker) => blocker.key !== key),
        { key, identity, diagnostic },
      ],
    });
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return true;
  }

  resolve(scopeInput: string): void {
    const key = this.hash(scopeInput);
    if (this.authority !== undefined) {
      this.authority.mutate(
        ProjectRunAuthority.mutationBlocksKey(this.projectId),
        { version: 1, projectId: this.projectId, blockers: [] },
        (value) => {
          const previous = stateSchema.parse(parseTaskMutationBlock(value));
          const remaining = previous.blockers.filter(
            (blocker) => blocker.key !== key,
          );
          return {
            value: stateSchema.parse({ ...previous, blockers: remaining }),
            result: undefined,
          };
        },
        stateSchema.parse,
      );
      return;
    }
    const previous = this.read();
    if (!previous.blockers.some((blocker) => blocker.key === key)) return;
    const remaining = previous.blockers.filter(
      (blocker) => blocker.key !== key,
    );
    if (remaining.length === 0) {
      try {
        fs.unlinkSync(this.filePath);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      return;
    }
    this.write({ version: 1, projectId: this.projectId, blockers: remaining });
  }

  private hash(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  private write(stateInput: z.input<typeof stateSchema>): void {
    const state = stateSchema.parse(stateInput);
    const directory = path.dirname(this.filePath);
    ensureDirectory(directory);
    const temporary = `${this.filePath}.${process.pid}.${this.hash(`${Date.now()}-${Math.random()}`)}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private read(): z.infer<typeof stateSchema> {
    if (this.authority !== undefined)
      return (
        this.authority.read(
          ProjectRunAuthority.mutationBlocksKey(this.projectId),
          stateSchema.parse,
        ) ?? { version: 1, projectId: this.projectId, blockers: [] }
      );
    try {
      const stat = fs.lstatSync(this.filePath, { throwIfNoEntry: false });
      if (stat === undefined)
        return { version: 1, projectId: this.projectId, blockers: [] };
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("Unsafe task mutation block state file");
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as unknown;
      const normalized = parseTaskMutationBlock(parsed);
      if (normalized.projectId !== this.projectId)
        throw new Error("Task mutation block project identity mismatch");
      return normalized;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      return { version: 1, projectId: this.projectId, blockers: [] };
    }
  }
}

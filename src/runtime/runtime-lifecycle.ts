import { logger } from "../logging/logger.js";

export type FatalErrorSource =
  "startup failure" | "uncaught exception" | "unhandled promise rejection";

export type ShutdownKind = "signal" | "fatal";

export interface RuntimeLogger {
  event(message: string): void;
  error(message: string): void;
}

export interface RuntimeLifecycleOptions {
  logger?: RuntimeLogger;
  secretValues?: readonly (string | undefined)[];
}

export interface FatalFailure {
  source: FatalErrorSource;
  error: unknown;
}

function getEnvironmentSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(name))
    .flatMap(([, value]) => (value === undefined ? [] : [value]));
}

function stringifyThrownValue(error: unknown): string {
  if (error instanceof Error) {
    try {
      const name =
        typeof error.name === "string" && error.name.trim().length > 0
          ? error.name.trim()
          : "Error";
      const message =
        typeof error.message === "string" && error.message.trim().length > 0
          ? error.message.trim()
          : "No error message provided";
      const stack = error.stack?.trim();

      if (stack === undefined) {
        return `${name}: ${message}`;
      }

      return `${name}: ${message}; Stack: ${stack}`;
    } catch {
      return "Unable to inspect thrown Error";
    }
  }

  if (typeof error === "string") {
    return error || "No error message provided";
  }

  try {
    const serialized = JSON.stringify(error);

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to String for circular or otherwise unserializable values.
  }

  try {
    return String(error);
  } catch {
    return "Unserializable thrown value";
  }
}

function redactSecrets(
  text: string,
  secretValues: ReadonlySet<string>,
): string {
  let redacted = text;

  for (const secretValue of [...secretValues].sort(
    (left, right) => right.length - left.length,
  )) {
    redacted = redacted.replaceAll(secretValue, "[REDACTED]");
  }

  redacted = redacted.replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
  redacted = redacted.replace(
    /([?&](?:key|token|api[_-]?key|access[_-]?token|password|secret)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(
    /(\b["']?(?:api[_-]?key|token|password|secret|authorization|credential|username)["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi,
    "$1[REDACTED]",
  );

  return redacted;
}

export function formatFatalDiagnostic(
  source: FatalErrorSource,
  error: unknown,
  secretValues: readonly (string | undefined)[] = [],
): string {
  const secrets = new Set(
    [...getEnvironmentSecretValues(), ...secretValues].filter(
      (value): value is string => value !== undefined && value.length > 0,
    ),
  );

  const details = redactSecrets(stringifyThrownValue(error), secrets);

  return `Fatal ${source}; requesting coordinated shutdown. ${details}`;
}

export class RuntimeLifecycle {
  readonly controller = new AbortController();

  private readonly lifecycleLogger: RuntimeLogger;
  private readonly secretValues: Set<string>;
  private shutdownKindValue: ShutdownKind | undefined;
  private fatalFailureValue: FatalFailure | undefined;

  constructor(options: RuntimeLifecycleOptions = {}) {
    this.lifecycleLogger = options.logger ?? logger;
    this.secretValues = new Set(
      [...getEnvironmentSecretValues(), ...(options.secretValues ?? [])].filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
    );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isShuttingDown(): boolean {
    return this.controller.signal.aborted;
  }

  get shutdownKind(): ShutdownKind | undefined {
    return this.shutdownKindValue;
  }

  get fatalFailure(): FatalFailure | undefined {
    return this.fatalFailureValue;
  }

  get exitCode(): 0 | 1 {
    return this.fatalFailureValue === undefined ? 0 : 1;
  }

  addSecretValues(values: readonly (string | undefined)[]): void {
    for (const value of values) {
      if (value !== undefined && value.length > 0) {
        this.secretValues.add(value);
      }
    }
  }

  requestSignalShutdown(signal: NodeJS.Signals): void {
    if (this.shutdownKindValue !== undefined) {
      return;
    }

    this.shutdownKindValue = "signal";

    try {
      this.lifecycleLogger.event(`Received ${signal}; shutting down...`);
    } catch {
      // A logging failure must not prevent the coordinated abort.
    } finally {
      this.controller.abort("signal");
    }
  }

  requestFatal(source: FatalErrorSource, error: unknown): void {
    if (this.fatalFailureValue === undefined) {
      this.fatalFailureValue = { source, error };

      const diagnostic = formatFatalDiagnostic(source, error, [
        ...this.secretValues,
      ]);

      try {
        this.lifecycleLogger.error(diagnostic);
      } catch {
        // The fatal path must still abort if the log destination is unavailable.
        try {
          console.error(diagnostic);
        } catch {
          // There is no safe fallback left, but shutdown remains best effort.
        }
      }
    }

    this.shutdownKindValue = "fatal";

    if (!this.controller.signal.aborted) {
      this.controller.abort("fatal");
    }
  }
}

export interface ProcessEventSource {
  on: NodeJS.Process["on"];
  removeListener: NodeJS.Process["removeListener"];
}

export function installProcessHandlers(
  lifecycle: RuntimeLifecycle,
  processObject: ProcessEventSource = process,
): () => void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    lifecycle.requestSignalShutdown(signal);
  };
  const handleUncaughtException = (error: Error): void => {
    lifecycle.requestFatal("uncaught exception", error);
  };
  const handleUnhandledRejection = (reason: unknown): void => {
    lifecycle.requestFatal("unhandled promise rejection", reason);
  };

  processObject.on("SIGINT", handleSignal);
  processObject.on("SIGTERM", handleSignal);
  processObject.on("uncaughtException", handleUncaughtException);
  processObject.on("unhandledRejection", handleUnhandledRejection);

  return () => {
    processObject.removeListener("SIGINT", handleSignal);
    processObject.removeListener("SIGTERM", handleSignal);
    processObject.removeListener("uncaughtException", handleUncaughtException);
    processObject.removeListener(
      "unhandledRejection",
      handleUnhandledRejection,
    );
  };
}

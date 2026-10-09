/** User-facing errors. The plugin and the CLI show these without a stack trace. */

export interface ErrorDetails {
  /** File (or other source) the problem is in. */
  path?: string | undefined;
  hint?: string | undefined;
}

/** Base class for errors that explain themselves to the user. */
export class MikuMotionError extends Error {
  readonly detail: string;
  readonly path: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, details: ErrorDetails = {}) {
    super(MikuMotionError.format(message, details));
    this.name = new.target.name;
    this.detail = message;
    this.path = details.path;
    this.hint = details.hint;
  }

  private static format(message: string, { path, hint }: ErrorDetails): string {
    const text = path ? `${path}: ${message}` : message;
    return hint ? `${text}\n  hint: ${hint}` : text;
  }

  /** The full message: source, problem and hint. */
  render(): string {
    return this.message;
  }
}

/** An input file is malformed or not the format it claims to be. */
export class InputFormatError extends MikuMotionError {
  readonly offset: number | undefined;

  constructor(message: string, details: ErrorDetails & { offset?: number | undefined } = {}) {
    const where = details.offset !== undefined ? ` (at byte offset ${details.offset})` : "";
    super(`${message}${where}`, details);
    this.offset = details.offset;
  }
}

/** The bone-mapping file is invalid or inconsistent with the inputs. */
export class MappingError extends MikuMotionError {}

/** The target model (e.g. .bbmodel) can't be used as a skeleton. */
export class TargetModelError extends MikuMotionError {}

/** A source skeleton file is invalid. */
export class SkeletonError extends MikuMotionError {}

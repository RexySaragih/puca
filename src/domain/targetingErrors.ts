export const NOT_A_GIT_REPOSITORY_MESSAGE =
  "Not a git repository. Pass --mutate <glob> to specify files.";

export const NO_FILES_TO_MUTATE_MESSAGE = "No files to mutate";

/**
 * Default targeting outside a git repo without --mutate (A6 refuse, exit 2).
 */
export class NotAGitRepositoryError extends Error {
  readonly name = "NotAGitRepositoryError";

  constructor() {
    super(NOT_A_GIT_REPOSITORY_MESSAGE);
  }
}

/**
 * --mutate matched nothing after hard excludes (A6 refuse, exit 2).
 */
export class EmptyMutateMatchError extends Error {
  readonly name = "EmptyMutateMatchError";

  constructor(mutateGlob: string) {
    super(
      `No files matched --mutate '${mutateGlob}' after hard excludes. Refused to score.`,
    );
  }
}

/**
 * --workspace matched no declared package roots (ADR-036 / SC-345 refuse, exit 2).
 */
export class EmptyWorkspaceMatchError extends Error {
  readonly name = "EmptyWorkspaceMatchError";

  constructor(workspaceGlob: string) {
    super(
      `Error: No packages matched --workspace '${workspaceGlob}'. Refused to score.`,
    );
  }
}

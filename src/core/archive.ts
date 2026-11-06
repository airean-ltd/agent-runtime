// A directory moved between sandboxes as one tar stream, packed and unpacked
// by tar inside the sandboxes, never on the job. The job only stores the
// bytes and caps them, so nothing the sandbox put in the archive (symlinks,
// odd modes, paths) ever touches the job's file system; it lands in the
// thread's next sandbox, whose files it was in the first place.
//
// Each command takes the directory as $1 and tar's own arguments after it, so
// no path or pattern is put through the shell.

/** Exit status of the pack command when the directory is not there. */
export const NO_DIRECTORY = 3;

/** `sh -c PACK_SCRIPT sh <dir> <tar args...>`: tar of the directory's contents on stdout. */
export const PACK_SCRIPT = `[ -d "$1" ] || exit ${NO_DIRECTORY}; cd "$1" && shift && tar "$@" .`;

/** `sh -c UNPACK_SCRIPT sh <dir> <tar args...>`: unpacks stdin into the directory, made if missing. */
export const UNPACK_SCRIPT = 'mkdir -p "$1" && cd "$1" && shift && tar "$@"';

export type PackOptions = {
  /** Paths under the directory to leave out, as `outputs` or `.cache/pip`. */
  exclude?: readonly string[];
  gzip?: boolean;
  /** The most the archive may be; a provider stops past it and rejects. */
  maxBytes: number;
};

/**
 * tar's arguments for packing. Every member is named `./...`, so an exclude
 * of `./outputs` matches that path only, in GNU and BSD tar alike.
 */
export function packArgs(opts: PackOptions): string[] {
  return [
    opts.gzip ? "-czf" : "-cf",
    "-",
    ...(opts.exclude ?? []).map((entry) => `--exclude=./${entry}`),
  ];
}

/** tar's arguments for unpacking stdin as the command's own user. */
export function unpackArgs(opts: { gzip?: boolean }): string[] {
  return [opts.gzip ? "-xzf" : "-xf", "-", "--no-same-owner"];
}

/** tar exits 1 when a file changed as it was read; the archive is still whole. */
export function packed(code: number | null): boolean {
  return code === 0 || code === 1;
}

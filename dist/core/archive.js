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
/**
 * tar's arguments for packing. Every member is named `./...`, so an exclude
 * of `./outputs` matches that path only, in GNU and BSD tar alike.
 */
export function packArgs(opts) {
    return [
        opts.gzip ? "-czf" : "-cf",
        "-",
        ...(opts.exclude ?? []).map((entry) => `--exclude=./${entry}`),
    ];
}
/** tar's arguments for unpacking stdin as the command's own user. */
export function unpackArgs(opts) {
    return [opts.gzip ? "-xzf" : "-xf", "-", "--no-same-owner"];
}
/** tar exits 1 when a file changed as it was read; the archive is still whole. */
export function packed(code) {
    return code === 0 || code === 1;
}

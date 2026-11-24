/** Exit status of the pack command when the directory is not there. */
export declare const NO_DIRECTORY = 3;
/** `sh -c PACK_SCRIPT sh <dir> <tar args...>`: tar of the directory's contents on stdout. */
export declare const PACK_SCRIPT = "[ -d \"$1\" ] || exit 3; cd \"$1\" && shift && tar \"$@\" .";
/** `sh -c UNPACK_SCRIPT sh <dir> <tar args...>`: unpacks stdin into the directory, made if missing. */
export declare const UNPACK_SCRIPT = "mkdir -p \"$1\" && cd \"$1\" && shift && tar \"$@\"";
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
export declare function packArgs(opts: PackOptions): string[];
/** tar's arguments for unpacking stdin as the command's own user. */
export declare function unpackArgs(opts: {
    gzip?: boolean;
}): string[];
/** tar exits 1 when a file changed as it was read; the archive is still whole. */
export declare function packed(code: number | null): boolean;

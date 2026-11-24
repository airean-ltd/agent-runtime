export declare class UnsafeFileError extends Error {
}
export type PlainOptions = {
    /** Keep symlinks as links, never followed; and, extracting, hard links as copies. Default false. */
    links?: boolean;
};
/** Reads a regular file, refusing a symlink (at the last component) or anything else. */
export declare function readPlainFile(file: string, maxBytes: number): Promise<Buffer>;
/**
 * Checks that `dir` and everything under it are plain directories and
 * regular files, at most `maxBytes` in all, without following anything. With
 * `links`, symlinks under `dir` pass too, unread; `dir` itself must still be
 * a directory.
 */
export declare function assertPlainTree(dir: string, maxBytes: number, options?: PlainOptions): Promise<void>;
/**
 * Extracts a tar archive into the existing directory `into`, creating only
 * directories and regular files (with O_EXCL and O_NOFOLLOW) and rejecting
 * links, devices, paths that leave `into`, and more than `maxBytes` of file
 * data. A file keeps its executable bit and nothing else of its mode. Reads
 * GNU, ustar and pax archives.
 *
 * With `links`, a symlink is made as it was, pointing wherever it pointed,
 * once everything else is in place, and an archive with anything under a
 * symlink is refused; a hard link is made a copy of the file it links to.
 */
export declare function extractPlainTar(archive: string, into: string, maxBytes: number, options?: PlainOptions): Promise<void>;

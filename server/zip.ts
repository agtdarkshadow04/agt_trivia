import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable, Transform } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import yazl from 'yazl';
import { ArchiveRejectedError } from './http.js';

/**
 * The only ZIP reader and writer (SEC-10). The reader checks the central
 * directory before anything is extracted: entry count, total uncompressed
 * size, absolute paths, `..` segments, backslashes, symbolic links and
 * directories are rejected, and only the paths in `allowed` may appear.
 */

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export interface SafeZipEntry {
  path: string;
  size: number;
  entry: Entry;
}

export interface SafeZip {
  entries: SafeZipEntry[];
  /** The entry's content as a stream; it fails if the entry is larger than its declared size. */
  stream(entry: SafeZipEntry): Promise<Readable>;
  close(): void;
}

const fileTypeMask = 0o170000;
const symlinkType = 0o120000;

/** BAK-2: a relative POSIX path without `.` or `..` segments, backslashes or a leading `/`. */
export function isSafePath(path: string) {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && !/^[a-zA-Z]:/.test(path) && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isSymlink(entry: Entry) {
  return ((entry.externalFileAttributes >>> 16) & fileTypeMask) === symlinkType;
}

/** Opens and checks an uploaded archive; `allowed` lists every path it may contain. */
export async function openSafeZip(file: string, limits: ZipLimits, allowed: ReadonlySet<string>): Promise<SafeZip> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, opened) => {
      if (error || !opened) reject(new ArchiveRejectedError('not_zip', `The file is not a ZIP archive: ${error?.message ?? 'unknown error'}`));
      else resolve(opened);
    });
  });
  try {
    if (zip.entryCount > limits.maxEntries) {
      throw new ArchiveRejectedError('unsafe_zip', `The archive has ${zip.entryCount} entries; the limit is ${limits.maxEntries}.`);
    }
    const entries: SafeZipEntry[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: Entry) => {
        try {
          const path = entry.fileName;
          if (!isSafePath(path) || path.endsWith('/')) throw new ArchiveRejectedError('unsafe_zip', `The archive contains an unsafe path or a directory (${JSON.stringify(path)}).`);
          if (isSymlink(entry)) throw new ArchiveRejectedError('unsafe_zip', `The archive contains a symbolic link (${path}).`);
          if (!allowed.has(path)) throw new ArchiveRejectedError('unlisted_file', `The archive contains ${path}, which a backup never contains.`);
          if (entries.some((existing) => existing.path === path)) throw new ArchiveRejectedError('unsafe_zip', `The archive contains ${path} twice.`);
          total += entry.uncompressedSize;
          if (total > limits.maxUncompressedBytes) {
            throw new ArchiveRejectedError('too_large', `The archive expands to more than ${limits.maxUncompressedBytes} bytes.`);
          }
          entries.push({ path, size: entry.uncompressedSize, entry });
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.on('end', () => resolve());
      zip.on('error', (error: Error) => reject(error instanceof ArchiveRejectedError ? error : new ArchiveRejectedError('unsafe_zip', `The archive is damaged: ${error.message}`)));
      zip.readEntry();
    });
    return {
      entries,
      close: () => zip.close(),
      stream: (item) => new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(item.entry, (error, stream) => {
          if (error || !stream) reject(new ArchiveRejectedError('unsafe_zip', `${item.path} cannot be read: ${error?.message ?? 'unknown error'}`));
          else resolve(stream);
        });
      }),
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}

/** Streams an entry through `sink` transforms into `file`, failing as unsafe_zip on a damaged entry. */
export async function extractEntry(zip: SafeZip, entry: SafeZipEntry, file: string, through: Transform[] = []) {
  try {
    await pipeline([await zip.stream(entry), ...through, createWriteStream(file)]);
  } catch (error) {
    if (error instanceof ArchiveRejectedError) throw error;
    throw new ArchiveRejectedError('unsafe_zip', `${entry.path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes a ZIP archive of buffers and files on disk to `file`. */
export async function writeZip(file: string, entries: { path: string; data?: Buffer; file?: string }[]) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    if (entry.file) zip.addFile(entry.file, entry.path);
    else zip.addBuffer(entry.data ?? Buffer.alloc(0), entry.path);
  }
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(file));
}

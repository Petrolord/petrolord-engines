// Windowed byte access for SEG-Y sources. Everything downstream (scan,
// transcode) consumes this interface instead of a File or ArrayBuffer, so
// the domain rule "never load a full SEG-Y volume into memory" is
// structural: there is no whole-file read anywhere in the engine, and
// jest can drive the same code with a Node buffer-backed reader.

/**
 * @typedef {Object} ByteReader
 * @property {number} size total source size in bytes
 * @property {(offset: number, length: number) => Promise<ArrayBuffer>} read
 *   read exactly `length` bytes at `offset` (throws past EOF)
 */

/**
 * Reader over a browser File/Blob using windowed slice() reads.
 * @param {Blob} file
 * @returns {ByteReader}
 */
export function fileReader(file) {
  return {
    size: file.size,
    async read(offset, length) {
      if (offset < 0 || offset + length > file.size) {
        throw new Error(`Read out of range: ${offset}+${length} of ${file.size}`);
      }
      return file.slice(offset, offset + length).arrayBuffer();
    },
  };
}

/**
 * Reader over an in-memory ArrayBuffer (tests, small previews).
 * @param {ArrayBuffer} buffer
 * @returns {ByteReader}
 */
export function bufferReader(buffer) {
  return {
    size: buffer.byteLength,
    async read(offset, length) {
      if (offset < 0 || offset + length > buffer.byteLength) {
        throw new Error(`Read out of range: ${offset}+${length} of ${buffer.byteLength}`);
      }
      return buffer.slice(offset, offset + length);
    },
  };
}

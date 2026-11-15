using System;
using System.IO;
using System.Text;

namespace FloorpLauncher
{
    /// <summary>
    /// Minimal codec for Mozilla's "mozLz4" file format used by files such as
    /// addonStartup.json.lz4: an 8-byte magic header "mozLz40\0", a 4-byte
    /// little-endian uncompressed size, followed by a raw LZ4 block.
    ///
    /// Decode implements the real LZ4 block algorithm. Encode deliberately
    /// emits a single "all literals" LZ4 sequence (no back-references) -
    /// this is valid LZ4 block data per spec, it is just not compressed.
    /// That is fine here: these files are a few KB and correctness matters
    /// more than ratio.
    /// </summary>
    internal static class MozLz4
    {
        private static readonly byte[] Magic = Encoding.ASCII.GetBytes("mozLz40\0");

        // 実物は数KB〜数百KB。壊れた/細工されたヘッダで巨大な確保をしないための上限。
        internal const int MaxUncompressedSize = 64 * 1024 * 1024;

        /// <summary>
        /// Returns false (never throws) for anything that isn't a complete,
        /// well-formed mozLz4 file, so a damaged file is never "decoded" into
        /// partial data and written back.
        /// </summary>
        public static bool TryDecode(byte[] input, out string json)
        {
            json = null;
            if (input == null || input.Length < 12) return false;
            for (int i = 0; i < 8; i++)
                if (input[i] != Magic[i]) return false;

            int uncompressedSize = BitConverter.ToInt32(input, 8);
            if (uncompressedSize < 0 || uncompressedSize > MaxUncompressedSize) return false;

            byte[] output = new byte[uncompressedSize];
            int inPos = 12;
            int outPos = 0;

            while (inPos < input.Length && outPos < uncompressedSize)
            {
                byte token = input[inPos++];
                int literalLength;
                if (!TryReadLength(input, ref inPos, (token >> 4) & 0x0F, out literalLength)) return false;
                if (literalLength > input.Length - inPos || literalLength > uncompressedSize - outPos) return false;

                Array.Copy(input, inPos, output, outPos, literalLength);
                inPos += literalLength;
                outPos += literalLength;

                // LZ4 ブロックの最終シーケンスはリテラルのみ。
                if (inPos >= input.Length) break;

                if (input.Length - inPos < 2) return false;
                int offset = input[inPos] | (input[inPos + 1] << 8);
                inPos += 2;
                if (offset == 0 || offset > outPos) return false;

                int matchLength;
                if (!TryReadLength(input, ref inPos, token & 0x0F, out matchLength)) return false;
                matchLength += 4;
                if (matchLength > uncompressedSize - outPos) return false;

                // 重なりコピー(offset < matchLength)があり得るので1バイトずつ。
                int matchPos = outPos - offset;
                for (int i = 0; i < matchLength; i++)
                {
                    output[outPos + i] = output[matchPos + i];
                }
                outPos += matchLength;
            }

            if (outPos != uncompressedSize) return false;

            json = Encoding.UTF8.GetString(output, 0, uncompressedSize);
            return true;
        }

        /// <summary>
        /// Reads an LZ4 length: the 4-bit nibble, plus 255-continued extra
        /// bytes when the nibble is 15.
        /// </summary>
        private static bool TryReadLength(byte[] input, ref int inPos, int nibble, out int length)
        {
            length = nibble;
            if (nibble != 15) return true;
            byte b;
            do
            {
                if (inPos >= input.Length) return false;
                b = input[inPos++];
                length += b;
                if (length > MaxUncompressedSize) return false;
            } while (b == 255);
            return true;
        }

        public static byte[] Encode(string json)
        {
            byte[] data = Encoding.UTF8.GetBytes(json);
            using (var ms = new MemoryStream())
            {
                ms.Write(Magic, 0, Magic.Length);
                ms.Write(BitConverter.GetBytes(data.Length), 0, 4);

                int literalLength = data.Length;
                int tokenLiteralNibble = Math.Min(literalLength, 15);
                ms.WriteByte((byte)(tokenLiteralNibble << 4));

                int remaining = literalLength - 15;
                if (literalLength >= 15)
                {
                    while (remaining >= 255)
                    {
                        ms.WriteByte(255);
                        remaining -= 255;
                    }
                    ms.WriteByte((byte)remaining);
                }

                ms.Write(data, 0, data.Length);
                return ms.ToArray();
            }
        }
    }
}

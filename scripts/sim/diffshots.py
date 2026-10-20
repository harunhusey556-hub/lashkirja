"""The exploratory walk's scroll shots (H8; X101, X157): no two consecutive shots of a long screen
('<name>', '<name>-vieritys1', '<name>-vieritys2', ...) may show the same page. A slow swipe past the
end left the page where it was, and x14-asetukset-vieritys1..3 and x07-raportit-vieritys2..4 were
one picture each, which read as coverage. `--differ A B` asks two named shots to differ too
(x12-asetukset-offline was Ostolaskut again while the walk looked for Asetukset, X130).

Shots are compared below the status bar (its clock) and left of the scroll indicator, which is all
that changed between the repeated ones. Prints one PASS, FAIL or MISS line per check, for notes.txt;
exits 1 on any FAIL or MISS. Python's standard library only: the CI runner's python3 has no imaging
package.
usage: diffshots.py <ui-shots dir> [prefix ...] [--differ A B ...]"""
import itertools, os, re, struct, sys, zlib

# The status bar's band and the scroll indicator's strip, as parts of the picture: the host's
# whole-device PNGs and the in-process ones differ in size.
TOP = 0.07
RIGHT = 0.96

SHOT = re.compile(r"^(?P<base>.+)-vieritys(?P<n>[0-9]+)(?P<rep>(-[0-9]+)?)\.png$")
LOW_BYTE = (0xFF).__and__


def add_bytes(a, b):
    """a + b byte by byte, mod 256, as whole-row integer arithmetic (no carry crosses a byte)."""
    n = len(a)
    x, y = int.from_bytes(a, "big"), int.from_bytes(b, "big")
    low, high = int.from_bytes(b"\x7f" * n, "big"), int.from_bytes(b"\x80" * n, "big")
    # The low seven bits of each byte add without reaching the next byte; the top bit is their xor.
    return (((x & low) + (y & low)) ^ ((x ^ y) & high)).to_bytes(n, "big")


def unfilter(kind, line, previous, channels):
    """One PNG row's bytes as drawn, from its filtered bytes and the row above (PNG spec 9.2)."""
    if kind == 0:
        return bytes(line)
    if kind == 1:
        out = bytearray(len(line))
        for c in range(channels):
            out[c::channels] = bytes(map(LOW_BYTE, itertools.accumulate(line[c::channels])))
        return bytes(out)
    if kind == 2:
        return add_bytes(line, previous)
    out = bytearray(line)
    if kind == 3:
        for x in range(len(out)):
            left = out[x - channels] if x >= channels else 0
            out[x] = (out[x] + ((left + previous[x]) >> 1)) & 0xFF
        return bytes(out)
    if kind == 4:
        for x in range(len(out)):
            if x >= channels:
                left, corner = out[x - channels], previous[x - channels]
            else:
                left = corner = 0
            up = previous[x]
            guess = left + up - corner
            pa, pb, pc = abs(guess - left), abs(guess - up), abs(guess - corner)
            out[x] = (out[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        return bytes(out)
    raise ValueError(f"filter type {kind}")


def png_rows(path):
    """(width, height, channels, rows) of an 8-bit, non-interlaced RGB or RGBA PNG; `rows` yields each
    row's bytes as drawn, one at a time, so a comparison can stop at the first row that differs."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    pos, idat, header = 8, [], None
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + length
    if header is None:
        raise ValueError(f"{path}: no IHDR")
    width, height, depth, colour, _, _, interlace = header
    channels = {2: 3, 6: 4}.get(colour)
    if depth != 8 or channels is None or interlace != 0:
        raise ValueError(f"{path}: depth {depth}, colour type {colour}, interlace {interlace} is not read here")
    raw = zlib.decompress(b"".join(idat))
    stride = width * channels

    def rows():
        previous = bytes(stride)
        for y in range(height):
            start = y * (stride + 1)
            line = unfilter(raw[start], raw[start + 1:start + 1 + stride], previous, channels)
            yield line
            previous = line

    return width, height, channels, rows()


def rgb(row, channels, width):
    """The first `width` pixels of a row as RGB bytes (an RGBA and an RGB picture of one screen agree)."""
    if channels == 3:
        return row[:width * 3]
    out = bytearray(width * 3)
    for c in range(3):
        out[c::3] = row[c:width * channels:channels]
    return bytes(out)


def same_screen(a, b):
    """Whether two shots show the same page, below the status bar and left of the scroll indicator."""
    wa, ha, ca, rows_a = png_rows(a)
    wb, hb, cb, rows_b = png_rows(b)
    if (wa, ha) != (wb, hb):
        return False
    top, right = int(ha * TOP), int(wa * RIGHT)
    for y, (row_a, row_b) in enumerate(zip(rows_a, rows_b)):
        if y >= top and rgb(row_a, ca, right) != rgb(row_b, cb, right):
            return False
    return True


def chains(folder, prefixes):
    """Each long screen's shots in order: '<name>' (when it was shot) and its '-vieritysN'."""
    found = {}
    for name in os.listdir(folder):
        match = SHOT.match(name)
        if not match or (prefixes and not match["base"].startswith(tuple(prefixes))):
            continue
        found.setdefault((match["base"], match["rep"]), []).append((int(match["n"]), name))
    result = []
    for (base, rep), shots in sorted(found.items()):
        names = [name for _, name in sorted(shots)]
        first = f"{base}{rep}.png"
        if os.path.exists(os.path.join(folder, first)):
            names.insert(0, first)
        result.append((base + rep, names))
    return result


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    folder, args = argv[1], argv[2:]
    prefixes, pairs = [], []
    while args:
        word = args.pop(0)
        if word == "--differ":
            if len(args) < 2:
                print("--differ needs two shot names")
                return 2
            pairs.append((args.pop(0), args.pop(0)))
        else:
            prefixes.append(word)
    failed = False
    for screen, names in chains(folder, prefixes):
        repeated = [(a, b) for a, b in zip(names, names[1:])
                    if same_screen(os.path.join(folder, a), os.path.join(folder, b))]
        for a, b in repeated:
            print(f"FAIL diffshots {a[:-4]} and {b[:-4]} show the same page")
        if not repeated:
            print(f"PASS diffshots {screen}: {len(names)} shots, each its own page")
        failed = failed or bool(repeated)
    for a, b in pairs:
        paths = [os.path.join(folder, f"{name}.png") for name in (a, b)]
        missing = [name for name, path in zip((a, b), paths) if not os.path.exists(path)]
        if missing:
            print(f"MISS diffshots {' and '.join(missing)} not shot")
            failed = True
        elif same_screen(*paths):
            print(f"FAIL diffshots {a} shows the same screen as {b}")
            failed = True
        else:
            print(f"PASS diffshots {a} differs from {b}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

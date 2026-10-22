"""Unit tests for diffshots.py (batch H8, X101 X157 X130): a scroll shot that repeats the page before it
fails, also when only the clock and the scroll indicator changed; a page that moved passes; the PNG
rows come back as drawn whatever filter each row was written with.
usage: python3 -m unittest discover -s scripts/sim -p 'test_diffshots.py'"""
import importlib.util, io, os, struct, tempfile, unittest, zlib
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("diffshots", os.path.join(HERE, "diffshots.py"))
diffshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diffshots)

WIDTH, HEIGHT = 50, 40


def page(offset, clock=0, indicator=0, channels=4):
    """A screen: a status band whose 'clock' varies, rows of a list that `offset` scrolls, and a
    scroll indicator in the right strip that `indicator` moves. Pixels as rows of bytes."""
    rows = []
    for y in range(HEIGHT):
        row = bytearray()
        for x in range(WIDTH):
            if y < 2:
                value = (clock * 37 + x) % 256
            elif x >= WIDTH - 1:
                value = 200 if (y + indicator) % 7 == 0 else 245
            else:
                value = ((y + offset) * 13 + x * 3) % 256
            row += bytes([value, (value * 5) % 256, (255 - value)][:3])
            if channels == 4:
                row.append(255)
        rows.append(bytes(row))
    return rows


def write_png(path, rows, channels=4):
    """An 8-bit PNG whose rows cycle through the five filter types, as an adaptive encoder mixes them."""
    stride = WIDTH * channels
    raw, previous = bytearray(), bytes(stride)
    for y, row in enumerate(rows):
        kind = y % 5
        out = bytearray(stride)
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 0:
                predicted = 0
            elif kind == 1:
                predicted = left
            elif kind == 2:
                predicted = up
            elif kind == 3:
                predicted = (left + up) // 2
            else:
                guess = left + up - corner
                pa, pb, pc = abs(guess - left), abs(guess - up), abs(guess - corner)
                predicted = left if pa <= pb and pa <= pc else up if pb <= pc else corner
            out[x] = (row[x] - predicted) % 256
        raw += bytes([kind]) + out
        previous = row

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 6 if channels == 4 else 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


class DiffShots(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def shot(self, name, rows, channels=4):
        write_png(os.path.join(self.dir.name, name + ".png"), rows, channels)

    def run_check(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = diffshots.main(["diffshots.py", self.dir.name, *args])
        return code, out.getvalue()

    def test_rows_come_back_as_drawn_through_every_filter(self):
        for channels in (3, 4):
            rows = page(3, clock=1, indicator=2, channels=channels)
            self.shot(f"filters{channels}", rows, channels)
            width, height, read_channels, read = diffshots.png_rows(os.path.join(self.dir.name, f"filters{channels}.png"))
            self.assertEqual((width, height, read_channels), (WIDTH, HEIGHT, channels))
            self.assertEqual(list(read), rows)

    def test_a_swipe_past_the_end_repeats_the_page_and_fails(self):
        # x14-asetukset run 39121314573: vieritys1..3 one page; only the scroll indicator moved.
        self.shot("x14-asetukset", page(0))
        self.shot("x14-asetukset-vieritys1", page(9, clock=1, indicator=1))
        self.shot("x14-asetukset-vieritys2", page(9, clock=2, indicator=4))
        self.shot("x14-asetukset-vieritys3", page(9, clock=3, indicator=5))
        code, out = self.run_check("x14")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL diffshots x14-asetukset-vieritys1 and x14-asetukset-vieritys2 show the same page", out)
        self.assertIn("FAIL diffshots x14-asetukset-vieritys2 and x14-asetukset-vieritys3 show the same page", out)
        self.assertNotIn("x14-asetukset and x14-asetukset-vieritys1", out)

    def test_a_first_swipe_that_moved_nothing_fails_against_the_screen_shot(self):
        self.shot("x07-raportit", page(0))
        self.shot("x07-raportit-vieritys1", page(0, clock=4))
        code, out = self.run_check("x07")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL diffshots x07-raportit and x07-raportit-vieritys1 show the same page", out)

    def test_pages_that_moved_pass(self):
        for n in range(4):
            self.shot("x15-ostolasku" + (f"-vieritys{n}" if n else ""), page(n * 5, clock=n))
        code, out = self.run_check("x15")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS diffshots x15-ostolasku: 4 shots, each its own page", out)

    def test_a_repeated_name_is_its_own_chain_and_other_prefixes_are_left_out(self):
        self.shot("x14-laskuttaja-vieritys1", page(2))
        self.shot("x14-laskuttaja-vieritys1-2", page(2))
        self.shot("x01-koti-vieritys1", page(1))
        self.shot("x01-koti-vieritys2", page(1))
        code, out = self.run_check("x14")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS diffshots x14-laskuttaja: 1 shots", out)
        self.assertIn("PASS diffshots x14-laskuttaja-2: 1 shots", out)
        self.assertNotIn("x01", out)

    def test_differ_pairs(self):
        # X130: x12-asetukset-offline was Ostolaskut again.
        self.shot("x12-ostolaskut-offline", page(1))
        self.shot("x12-asetukset-offline", page(1, clock=2, channels=3), channels=3)
        code, out = self.run_check("--differ", "x12-asetukset-offline", "x12-ostolaskut-offline")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL diffshots x12-asetukset-offline shows the same screen as x12-ostolaskut-offline", out)

        self.shot("x12-asetukset-offline-2", page(6))
        code, out = self.run_check("--differ", "x12-asetukset-offline-2", "x12-ostolaskut-offline",
                                   "--differ", "x12-laitteet-offline", "x12-ostolaskut-offline")
        self.assertEqual(code, 1, out)
        self.assertIn("PASS diffshots x12-asetukset-offline-2 differs from x12-ostolaskut-offline", out)
        self.assertIn("MISS diffshots x12-laitteet-offline not shot", out)


if __name__ == "__main__":
    unittest.main()

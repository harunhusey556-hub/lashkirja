"""How dark is a simulator screenshot? Used by ios-sim-run.sh on the macOS
runner for the first seconds of each launch (the launch screen, then the
SplashScreen plugin's copy of it), which must be the light canvas with the
icon, never black.

The runner's python3 has no PIL, so the PNG is first converted to BMP with
`sips -s format bmp` and read here with the standard library only.

Usage: python3 launch-luminance.py <file.bmp> <label>
Prints: "<label>: mean luminance N, dark share F" plus "  DARK" when most of
the sampled grid is near-black.
"""
import struct
import sys


def main() -> None:
    path, label = sys.argv[1], sys.argv[2]
    data = open(path, "rb").read()
    offset = struct.unpack_from("<I", data, 10)[0]
    width, height = struct.unpack_from("<ii", data, 18)
    bytes_per_pixel = struct.unpack_from("<H", data, 28)[0] // 8
    row = (width * bytes_per_pixel + 3) & ~3
    rows = abs(height)
    lums = []
    for gy in range(1, 40):
        for gx in range(1, 20):
            x, y = width * gx // 20, rows * gy // 40
            i = offset + y * row + x * bytes_per_pixel
            b, g, r = data[i], data[i + 1], data[i + 2]
            lums.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
    mean = sum(lums) / len(lums)
    dark = sum(1 for value in lums if value < 40) / len(lums)
    flag = "  DARK" if dark > 0.6 else ""
    print(f"{label}: mean luminance {mean:.0f}, dark share {dark:.2f}{flag}")


if __name__ == "__main__":
    main()

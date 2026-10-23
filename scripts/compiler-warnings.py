"""No compiler warning in the repo's own Swift sources (N002). 389 of them sat in the iOS build log for
weeks: xcbeautify drops a warning's file and line, and a log of thousands of lines hides the rest. This
reads the raw output of `swift test` or `xcodebuild` and lists each distinct warning in a file under
ios-native/, and any SwiftPM warning about the package itself (unhandled files). The SDK's, the checked-out
packages' and Xcode's own tools' warnings are not the repo's to fix and are not listed. An empty log is a
build whose output was not captured, not a clean build.
usage: compiler-warnings.py <build log>..."""
import re, sys

ANSI = re.compile(r"\x1b\[[0-9;]*m")
# swiftc and xcodebuild: `/abs/ios-native/<file>:<line>:<col>: warning: <text>`; a project file has no line.
LOCATED = re.compile(r"^(?P<path>/\S*?/ios-native/[^:\s]+?)(?::(?P<line>\d+)(?::(?P<col>\d+))?)?: warning: (?P<text>.+)$")
# SwiftPM, about the package: `warning: 'lashkirjacore': found 19 file(s) which are unhandled; ...`.
PACKAGE = re.compile(r"^warning: (?P<text>.+)$")
# Built files and checked-out packages sit under the same ios-native/ tree on the runner.
NOT_OURS = ("/.build/", "/build/", "/SourcePackages/")


def warnings(log):
    """The distinct warnings of the repo's own sources as (file, line, col, text), in the order first printed.
    A build for two architectures prints each one twice."""
    found = {}
    for raw in log.splitlines():
        line = ANSI.sub("", raw).strip()
        located = LOCATED.match(line)
        if located:
            path = located["path"]
            if any(part in path for part in NOT_OURS):
                continue
            where = "ios-native/" + path.split("/ios-native/", 1)[1]
            key = (where, int(located["line"] or 0), int(located["col"] or 0), located["text"])
        elif PACKAGE.match(line):
            key = ("", 0, 0, line)
        else:
            continue
        found.setdefault(key, None)
    return list(found)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    count = 0
    for path in argv[1:]:
        with open(path, encoding="utf-8", errors="replace") as f:
            log = f.read()
        if not log.strip():
            print(f"::error::{path} is empty: the build output was not captured")
            return 2
        for file, line, col, text in warnings(log):
            count += 1
            if file:
                where = f" file={file}" + (f",line={line}" if line else "") + (f",col={col}" if col else "")
                print(f"::error{where}::{text}")
            else:
                print(f"::error::{text}")
    print(f"{count} compiler warning(s) in the repo's own sources")
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

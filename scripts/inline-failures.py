"""A write's failure is not put in the list (G003). A Section, or a row, that appears in a List or
Form only to say a save failed pushes everything under it down (U045), or lands below the fold of a
long form where nothing on screen says the save failed. `.failureToast($failure)` and
`.noticeToast($notice)` (Components.swift) say it over the screen's bottom instead. Reported: a
`Section` whose only content is a Text of a variable that is drawn in Theme.danger or is named for
a failure, notice, message, error or problem, and an `if let ...failure... { Text(...) }` with
nothing else in it. Left on purpose, a failure that is the screen itself (a load that failed, a
footer line, a pinned bottom stack) says why on its line or the line above:
`// inline failure kept: <why>`.
Swift is read as swipe-roles.py reads it: comments, strings and brackets are skipped alike.
usage: inline-failures.py <directory or .swift file>..."""
import importlib.util, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("swipe_roles", os.path.join(HERE, "swipe-roles.py"))
swift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(swift)

SECTION = re.compile(r"\bSection\s*\{")
# `if let failure {`, `else if let importFailure {`, `if let failure = model.failure {`.
FAILURE_IF = re.compile(r"\bif\s+let\s+\w*[Ff]ailure\w*\b(?:\s*=\s*[^{\n]+)?\s*\{")
# A Text of a variable or member (`Text(failure)`, `Text(failure.message)`), not of a string literal
# or of a type's static copy (`Text(PurchaseReceiptLinkText.empty)`).
VARIABLE_TEXT = re.compile(r"Text\(\s*([a-z_][\w.]*)\s*\)")
A_MESSAGE = re.compile(r"failure|notice|message|error|problem", re.IGNORECASE)
KEPT = re.compile(r"//\s*inline failure kept:")


def variable_text(step):
    """The variable a statement shows with Text(...), or None."""
    match = VARIABLE_TEXT.match(step)
    return match.group(1) if match else None


def says_message(step):
    """Whether the statement is a Text of a variable that is drawn in the danger colour or named for a message."""
    name = variable_text(step)
    return name is not None and ("Theme.danger" in step or A_MESSAGE.search(name) is not None)


def findings(src):
    """(line, text) for each failure Section or row, but those marked as kept."""
    kept_lines = src.split("\n")
    code = swift.blank_comments(src)
    starts = set()
    for pattern, shows in ((SECTION, says_message), (FAILURE_IF, variable_text)):
        for match in pattern.finditer(code):
            brace = match.end() - 1
            steps = swift.statements(code[brace + 1:swift.closing(code, brace)])
            if len(steps) == 1 and shows(steps[0]):
                starts.add(match.start())
    found = []
    for start in sorted(starts):
        line = code.count("\n", 0, start) + 1
        if any(KEPT.search(kept_lines[i]) for i in (line - 1, line - 2) if i >= 0):
            continue
        found.append((line, code[start:].split("\n", 1)[0].strip()))
    return found


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    count = 0
    for path in swift.swift_files(argv[1:]):
        with open(path, encoding="utf-8") as f:
            src = f.read()
        shown = path.replace(os.sep, "/")
        for line, text in findings(src):
            count += 1
            print(f"::error file={shown},line={line}::A failure put in the list moves what lies under it (G003). "
                  f"Say it with .failureToast($failure) on the screen, or keep it with a line above: "
                  f"// inline failure kept: <why>: {text}")
    print(f"{count} inline failure(s) in a list")
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

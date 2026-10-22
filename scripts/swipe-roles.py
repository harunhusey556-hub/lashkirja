"""A swipe action that only asks first carries no destructive role (F009). In a List, a swipe Button
with `role: .destructive` makes SwiftUI animate its row out at the tap, before the question is
answered, and after Peruuta the row stayed off the list until a reload, though nothing was deleted
(Laitteet, UI suite run 39538176287). A Button whose action only sets state (the question's target
or flag) is such a question. A swipe that deletes at once keeps its role, and so does a destructive
Button in a menu or in the question itself: only the rows of a List are taken off.
usage: swipe-roles.py <directory or .swift file>..."""
import os, re, sys

SWIPE = re.compile(r"\.swipeActions\b")
BUTTON = re.compile(r"\bButton\s*\(")
DESTRUCTIVE = re.compile(r"\brole:\s*\.destructive\b")
ACTION = re.compile(r"\baction:\s*")
# `name = value`, `a.b = value` or `let name = value`; not `==`, and not `_ = call()`, which runs the call.
ASSIGNMENT = re.compile(r"(?:(?:let|var)\s+)?(?!_\s*=)[A-Za-z_][\w.]*\s*=(?!=)")
# A line that carries on the statement above it (`? a : b`, `.member`, `&& b`).
CONTINUATION = re.compile(r"[.?:&|+\-*/<>=]")
OPENING = {"(": ")", "{": "}", "[": "]"}


def literal_end(src, i):
    """The index just past the string literal or comment that starts at `i`; `i` when none does."""
    if src.startswith("//", i):
        end = src.find("\n", i)
        return len(src) if end < 0 else end
    if src.startswith("/*", i):
        end = src.find("*/", i + 2)
        return len(src) if end < 0 else end + 2
    quote = '"""' if src.startswith('"""', i) else '"' if src.startswith('"', i) else None
    if quote is None:
        return i
    j = i + len(quote)
    while j < len(src):
        if src.startswith("\\(", j):
            # An interpolation can hold strings of its own: "\(done ? "x" : "y")".
            j = closing(src, j + 1) + 1
        elif src[j] == "\\":
            j += 2
        elif src.startswith(quote, j):
            return j + len(quote)
        else:
            j += 1
    return len(src)


def closing(src, i):
    """The index of the bracket that closes the one at `i`, past strings and comments."""
    depth, j = 0, i
    while j < len(src):
        end = literal_end(src, j)
        if end != j:
            j = end
            continue
        if src[j] in OPENING:
            depth += 1
        elif src[j] in ")}]":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return len(src)


def blank_comments(src):
    """`src` with each comment turned into spaces (line ends kept), so offsets and lines still match."""
    out, j = [], 0
    while j < len(src):
        end = literal_end(src, j)
        if end == j:
            out.append(src[j])
            j += 1
            continue
        piece = src[j:end]
        out.append(re.sub(r"[^\n]", " ", piece) if piece.startswith(("//", "/*")) else piece)
        j = end
    return "".join(out)


def statements(body):
    """The closure body's top-level statements: split at line ends and ';' outside brackets."""
    parts, start, depth, j = [], 0, 0, 0
    while j < len(body):
        end = literal_end(body, j)
        if end != j:
            j = end
            continue
        c = body[j]
        if c in OPENING:
            depth += 1
        elif c in ")}]":
            depth -= 1
        elif c in "\n;" and depth == 0:
            parts.append(body[start:j])
            start = j + 1
        j += 1
    parts.append(body[start:])
    joined = []
    for part in (p.strip() for p in parts):
        if not part:
            continue
        if joined and CONTINUATION.match(part):
            joined[-1] += " " + part
        else:
            joined.append(part)
    return joined


def skip_space(src, j):
    while j < len(src) and src[j].isspace():
        j += 1
    return j


def action_body(src, button):
    """The action closure's body of the Button whose '(' is at `button`; None when it is no closure."""
    end = closing(src, button)
    args = src[button + 1:end]
    named = ACTION.search(args)
    if named:
        # `action:` given: a trailing closure is then the label.
        start = button + 1 + named.end()
    else:
        start = skip_space(src, end + 1)
    if start >= len(src) or src[start] != "{":
        return None
    return src[start + 1:closing(src, start)]


def findings(src):
    """(line, button text) for each swipe Button with a destructive role whose action only assigns."""
    src = blank_comments(src)
    found = []
    for swipe in SWIPE.finditer(src):
        j = skip_space(src, swipe.end())
        end = j
        if j < len(src) and src[j] == "(":
            end = closing(src, j)
            j = skip_space(src, end + 1)
        # The content closure, or `content:` inside the parentheses.
        if j < len(src) and src[j] == "{":
            end = closing(src, j)
        for button in BUTTON.finditer(src, swipe.end(), end):
            paren = button.end() - 1
            if not DESTRUCTIVE.search(src[paren:closing(src, paren)]):
                continue
            body = action_body(src, paren)
            steps = statements(body) if body is not None else []
            if steps and all(ASSIGNMENT.match(step) for step in steps):
                line = src.count("\n", 0, button.start()) + 1
                found.append((line, src[button.start():].split("\n", 1)[0].strip()))
    return found


def swift_files(paths):
    for path in paths:
        if os.path.isfile(path):
            yield path
            continue
        for root, dirs, files in os.walk(path):
            dirs.sort()
            for name in sorted(files):
                if name.endswith(".swift"):
                    yield os.path.join(root, name)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    count = 0
    for path in swift_files(argv[1:]):
        with open(path, encoding="utf-8") as f:
            src = f.read()
        shown = path.replace(os.sep, "/")
        for line, text in findings(src):
            count += 1
            print(f"::error file={shown},line={line}::A swipe Button with role: .destructive that only asks first "
                  f"takes its row off the list before the answer (F009). Drop the role and keep the fill with "
                  f".tint(Theme.accentFill): {text}")
    print(f"{count} swipe question(s) with a destructive role")
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

"""Unit tests for inline-failures.py (G003): a failure or notice put in the list as a Section, and a
bare `if let ...failure...` row, are reported with their line; a field's own error, a Section with
more in it or a static copy, and a line marked `// inline failure kept: ...` are not; strings and
comments with braces do not move the block's end.
usage: python3 -m unittest discover -s scripts -p 'test_inline_failures.py'"""
import importlib.util, io, os, tempfile, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("inline_failures", os.path.join(HERE, "inline-failures.py"))
inline_failures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inline_failures)


def lines(src):
    return [line for line, _ in inline_failures.findings(src)]


class InlineFailures(unittest.TestCase):
    def test_a_failure_section_in_an_if_is_reported(self):
        # InvoiceDetailView before U045: the card pushed the tabs 94 pt down.
        src = """
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            Section { tabPicker(tabs) }
        """
        self.assertEqual(lines(src), [2])

    def test_the_section_over_several_lines_and_with_a_transition_is_reported(self):
        # PurchaseBankLinkViews before G003.
        src = """
            if let failure {
                Section { Text(failure).foregroundStyle(Theme.danger) }.transition(.opacity)
            }
            Section {
                Text(failure.message)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
            }
        """
        self.assertEqual(lines(src), [3, 5])

    def test_a_notice_section_is_reported_without_the_danger_colour(self):
        # CustomersView's notice and PurchaseMatchView's message pushed their lists down.
        src = """
            if let notice { Section { Text(notice).font(.subheadline) } }
            if let message {
                Section { Text(message).font(.subheadline).foregroundStyle(Theme.ink) }
                    .listRowBackground(Theme.accentSoft)
            }
        """
        self.assertEqual(lines(src), [2, 4])

    def test_a_bare_failure_row_is_reported_whatever_it_is_called(self):
        src = """
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
            } else if let importFailure {
                Text(importFailure).font(.footnote).foregroundStyle(Theme.danger)
                    .transition(.opacity)
            }
            if let failure = model.failure { Text(failure) }
        """
        self.assertEqual(lines(src), [2, 3, 7])

    def test_a_section_or_row_with_more_in_it_is_not_reported(self):
        # The load failure with its retry, and the failure with its button, say more than the message.
        src = """
            Section {
                Text(profileFailure).foregroundStyle(Theme.danger)
                Button("Yritä uudelleen") { Task { await loadProfile() } }
            }
            if let failure {
                VStack {
                    Text(failure).foregroundStyle(Theme.danger)
                    Button("Yritä uudelleen") { retry() }
                }
            }
            if let failure { Label(failure, systemImage: "exclamationmark.circle") }
        """
        self.assertEqual(lines(src), [])

    def test_copy_that_is_not_a_message_is_not_reported(self):
        # A literal, a type's static text, a call and a titled Section are screens' own words.
        src = """
            Section { Text("Ei vielä tiliotteita.").foregroundStyle(Theme.danger) }
            Section { Text(PurchaseReceiptLinkText.empty).font(.subheadline).foregroundStyle(Theme.ink) }
            Section { Text(PurchaseReceiptLinkText.intro(invoice)).font(.subheadline) }
            Section("Muistiinpanot") { Text(notes) }
            Section { Text(summary).font(.subheadline) }
            Section { Text(blocked).foregroundStyle(Theme.ink) }
        """
        self.assertEqual(lines(src), [])

    def test_a_field_error_is_not_a_failure_row(self):
        # Under its field, named for the field: the owner's input is what moves, not a save's answer.
        src = """
            if let emailError { Text(emailError).font(.footnote).foregroundStyle(Theme.danger) }
            if let message = errors[field] { Text(message).font(.footnote).foregroundStyle(Theme.danger) }
        """
        self.assertEqual(lines(src), [])

    def test_a_line_marked_as_kept_is_not_reported_but_only_the_next_one(self):
        src = """
            // inline failure kept: under the buttons, so they never move
            if let importFailure { Text(importFailure).foregroundStyle(Theme.danger) }
            if let failure { Text(failure).foregroundStyle(Theme.danger) } // inline failure kept: the footer's own line
            // inline failure kept: a comment two lines up is not for this one

            if let failure { Text(failure).foregroundStyle(Theme.danger) }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        """
        self.assertEqual(lines(src), [7, 8])

    def test_braces_in_strings_and_comments_do_not_end_the_block(self):
        src = """
            Section {
                // } a closing brace in a comment
                Text(failure).foregroundStyle(Theme.danger)
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) } // } {
            Label("Virhe }", systemImage: "xmark") ; Section { Text("{") }
        """
        self.assertEqual(lines(src), [2, 6])

    def test_a_commented_out_section_is_none(self):
        src = """
            // if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            /* Section { Text(notice) } */
        """
        self.assertEqual(lines(src), [])

    def test_main_annotates_each_finding_and_fails_only_when_there_is_one(self):
        with tempfile.TemporaryDirectory() as root:
            bad = os.path.join(root, "Bad.swift")
            good = os.path.join(root, "Good.swift")
            with open(bad, "w", encoding="utf-8") as f:
                f.write("List {\n    if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }\n}\n")
            with open(good, "w", encoding="utf-8") as f:
                f.write("List {\n}\n.background(Theme.canvas)\n.failureToast($failure)\n")
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(inline_failures.main(["inline-failures.py", root]), 1)
            self.assertIn("Bad.swift,line=2::", out.getvalue())
            self.assertNotIn("Good.swift", out.getvalue())
            with redirect_stdout(io.StringIO()):
                self.assertEqual(inline_failures.main(["inline-failures.py", good]), 0)


if __name__ == "__main__":
    unittest.main()

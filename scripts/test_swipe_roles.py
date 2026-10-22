"""Unit tests for swipe-roles.py (F009): a swipe Button with a destructive role whose action only sets
state is reported with its line; one that deletes at once, a plain tinted one, and a destructive
Button in a menu are not; strings and comments with braces do not move the swipe block's end.
usage: python3 -m unittest discover -s scripts -p 'test_swipe_roles.py'"""
import importlib.util, io, os, tempfile, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("swipe_roles", os.path.join(HERE, "swipe-roles.py"))
swipe_roles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(swipe_roles)


def lines(src):
    return [line for line, _ in swipe_roles.findings(src)]


class SwipeRoles(unittest.TestCase):
    def test_a_question_behind_a_destructive_swipe_is_reported(self):
        # EmailImportView before F009.
        src = """
            .swipeActions {
                Button("Katkaise", role: .destructive) { disconnecting = account }
            }
        """
        self.assertEqual(lines(src), [3])

    def test_the_label_first_form_inside_an_if_is_reported(self):
        # PurchaseInvoicesView's row before F009.
        src = """
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if invoice.canDelete {
                Button(role: .destructive) { deleteTarget = invoice } label: { Label("Poista", systemImage: "trash") }
            }
        }
        """
        self.assertEqual(lines(src), [4])

    def test_several_assignments_and_a_ternary_over_two_lines_are_still_only_state(self):
        # ReceiptsView's two flags, and PurchaseInvoiceDetailView's payment question split over lines.
        src = """
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    deleteIds = [receipt.id]
                    confirmDelete = true
                } label: { Label("Poista", systemImage: "trash") }
            }
            .swipeActions(edge: .leading) {
                Button(role: .destructive) {
                    confirm = payment.isLinkedToBank
                        ? .unlinkPayment(payment) : .removePayment(payment)
                } label: { Label("Irrota", systemImage: "link") }
            }
        """
        self.assertEqual(lines(src), [3, 9])

    def test_an_action_argument_closure_is_read_and_a_named_action_is_not(self):
        src = """
            .swipeActions {
                Button("Poista", role: .destructive, action: { deleting = key })
                Button(role: .destructive, action: remove) { Label("Poista", systemImage: "trash") }
            }
        """
        self.assertEqual(lines(src), [3])

    def test_a_swipe_that_deletes_at_once_keeps_its_role(self):
        src = """
            .swipeActions {
                Button("Poista", role: .destructive) { Task { await deletePayment(payment) } }
                Button("Poista", role: .destructive) { remove(template) }
                Button("Poista", role: .destructive) { _ = withMotion { draft.lines.remove(at: index) } }
                Button("Poista", role: .destructive) { Haptics.selection(); deleting = key }
            }
        """
        self.assertEqual(lines(src), [])

    def test_a_plain_tinted_question_is_not_reported(self):
        # Laitteet after H3, and the fixed form of the others.
        src = """
            .swipeActions {
                if !s.current { Button("Kirjaa ulos") { confirmSession = s }.tint(Theme.accentFill) }
                Button { deleteTarget = invoice } label: { Label("Poista", systemImage: "trash") }
                    .tint(Theme.accentFill)
            }
        """
        self.assertEqual(lines(src), [])

    def test_a_destructive_question_in_a_menu_after_the_swipe_is_not_reported(self):
        # Only a List row is taken off: the context menu and the question keep their role.
        src = """
            .swipeActions {
                Button("Päivitä") { Task { await sync(connection) } }.tint(Theme.accentFill)
            }
            .contextMenu {
                Button(role: .destructive) { disconnecting = connection } label: { Label("Katkaise yhteys", systemImage: "xmark.circle") }
            }
            Menu {
                Button("Poista", role: .destructive) { confirmRemove = item.id }
            } label: { Text("Toiminnot") }
        """
        self.assertEqual(lines(src), [])

    def test_braces_in_strings_and_comments_do_not_end_the_block(self):
        src = """
            .swipeActions {
                // } a closing brace in a comment
                Button("Poista }", role: .destructive) { title = "\\(done ? "}" : "{")" }
                /* } */ Button("Muokkaa {", role: .destructive) { editing = row }
            }
            Button("Poista", role: .destructive) { deleting = key }
        """
        self.assertEqual(lines(src), [4, 5])

    def test_a_comment_in_the_action_is_no_statement_and_a_commented_out_swipe_is_none(self):
        src = """
            .swipeActions {
                Button("Poista", role: .destructive) {
                    // The question names the key.
                    deleting = key
                }
            }
            // .swipeActions { Button("Poista", role: .destructive) { deleting = key } }
        """
        self.assertEqual(lines(src), [3])

    def test_main_annotates_each_finding_and_fails_only_when_there_is_one(self):
        with tempfile.TemporaryDirectory() as root:
            bad = os.path.join(root, "Bad.swift")
            good = os.path.join(root, "Good.swift")
            with open(bad, "w", encoding="utf-8") as f:
                f.write('.swipeActions {\n    Button("Poista", role: .destructive) { deleting = key }\n}\n')
            with open(good, "w", encoding="utf-8") as f:
                f.write('.swipeActions {\n    Button("Poista") { deleting = key }.tint(Theme.accentFill)\n}\n')
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(swipe_roles.main(["swipe-roles.py", root]), 1)
            self.assertIn("Bad.swift,line=2::", out.getvalue())
            self.assertNotIn("Good.swift", out.getvalue())
            with redirect_stdout(io.StringIO()):
                self.assertEqual(swipe_roles.main(["swipe-roles.py", good]), 0)


if __name__ == "__main__":
    unittest.main()
